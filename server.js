/**
 * CANTINHO DA SARAH — SERVER.JS
 * -----------------------------------------------------------------------------
 * Servidor Node.js/Express para:
 *   POST   /api/mini-ia       Respostas positivas sobre a Sarah
 *   GET    /api/album         Lista as fotos do Shadow e da Sky
 *   POST   /api/album/upload  Envia fotos ao Supabase Storage + tabela
 *   DELETE /api/album/:id     Exclui uma foto com senha administrativa
 *   GET    /api/health        Verifica a configuração básica do servidor
 *
 * Segurança:
 *   - Credenciais do Supabase e OpenAI ficam apenas no .env.
 *   - O bucket de fotos é privado; o servidor gera URLs assinadas temporárias.
 *   - A exclusão exige ALBUM_ADMIN_PASSWORD.
 *   - Uploads são limitados por quantidade, tamanho, extensão e assinatura real.
 *   - As rotas possuem limites básicos de requisições.
 *
 * Requisitos: Node.js 20 ou superior.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { fileTypeFromBuffer } from 'file-type';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const frontEndDir = path.join(projectRoot, 'front-end');
const assetsDir = path.join(projectRoot, 'assets');
// -----------------------------------------------------------------------------
// CONFIGURAÇÃO
// -----------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// A chave secreta atual (sb_secret_...) é preferida; a antiga service_role continua aceita.
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'sarah-album';
const ALBUM_ADMIN_PASSWORD = process.env.ALBUM_ADMIN_PASSWORD || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

const MAX_PHOTO_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB por foto
const MAX_PHOTOS_PER_UPLOAD = 8;
const SIGNED_URL_TTL_SECONDS = 12 * 60 * 60; // 12 horas; URLs novas são criadas a cada consulta
const ALLOWED_IMAGE_TYPES = new Map([
    ['jpg', { mime: 'image/jpeg', extension: 'jpg' }],
    ['jpeg', { mime: 'image/jpeg', extension: 'jpg' }],
    ['png', { mime: 'image/png', extension: 'png' }],
    ['webp', { mime: 'image/webp', extension: 'webp' }],
    ['heic', { mime: 'image/heic', extension: 'heic' }],
    ['heif', { mime: 'image/heif', extension: 'heif' }]
]);

const supabase = SUPABASE_URL && SUPABASE_SECRET_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        },
        global: {
            headers: { 'x-application-name': 'cantinho-da-sarah' }
        }
    })
    : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Helmet fornece cabeçalhos de segurança. A CSP fica desativada aqui para não
// bloquear as fontes externas e os recursos visuais já utilizados pelo site.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '20kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// O servidor entrega somente os arquivos públicos necessários. Não expõe
// server.js, .env, package.json, scripts SQL ou outros arquivos de configuração.
app.get('/', (_req, res) =>
    res.sendFile(path.join(frontEndDir, 'index.html'))
);

app.get('/index.html', (_req, res) =>
    res.sendFile(path.join(frontEndDir, 'index.html'))
);

app.get('/style.css', (_req, res) =>
    res.sendFile(path.join(frontEndDir, 'style.css'))
);

app.get('/script.js', (_req, res) =>
    res.sendFile(path.join(frontEndDir, 'script.js'))
);

app.use('/assets', express.static(assetsDir, {
    dotfiles: 'deny',
    fallthrough: false,
    index: false,
    maxAge: NODE_ENV === 'production' ? '7d' : 0
}));

// -----------------------------------------------------------------------------
// LIMITES DE REQUISIÇÃO
// -----------------------------------------------------------------------------

const aiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Muitas perguntas em pouco tempo. Espere um pouquinho e tente novamente. ♡' }
});

const albumReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Muitas consultas ao álbum. Tente novamente em instantes.' }
});

const albumWriteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'O limite temporário de envios foi atingido. Tente novamente mais tarde.' }
});

// -----------------------------------------------------------------------------
// FUNÇÕES AUXILIARES
// -----------------------------------------------------------------------------

function sendError(res, status, message) {
    return res.status(status).json({ message });
}

function isSupabaseConfigured() {
    return Boolean(supabase);
}

function safeEqualStrings(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);
    if (receivedBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function requireAlbumBackend(res) {
    if (!isSupabaseConfigured()) {
        sendError(
            res,
            503,
            'O álbum ainda não está conectado ao Supabase. Configure SUPABASE_URL e SUPABASE_SECRET_KEY no arquivo .env.'
        );
        return false;
    }
    return true;
}

function getSupabaseSetupHint(error) {
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('bucket not found') || message.includes('does not exist')) {
        return ' Crie o bucket privado "sarah-album" no Supabase Storage.';
    }
    if (message.includes('album_photos') || message.includes('relation')) {
        return ' Execute o arquivo supabase-schema.sql no SQL Editor do Supabase.';
    }
    return '';
}

function mapPhotoRow(row, signedUrl) {
    return {
        id: row.id,
        pet: row.pet,
        url: signedUrl,
        caption: row.caption || '',
        createdAt: row.created_at
    };
}

async function createSignedPhoto(row) {
    const { data, error } = await supabase.storage
        .from(SUPABASE_STORAGE_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
        throw new Error(error?.message || 'Não foi possível criar o link temporário da foto.');
    }
    return mapPhotoRow(row, data.signedUrl);
}

function fallbackAiAnswer(question, style) {
    const normalized = question
        .toLocaleLowerCase('pt-BR')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const topic = /shadow|sky|gato|gata|pet|patinha|mi(a|u)/.test(normalized)
        ? 'pets'
        : /sorr|feliz|alegr|trist|dia ruim|animar/.test(normalized)
            ? 'smile'
            : /bonita|linda|beleza|aparencia/.test(normalized)
                ? 'beauty'
                : /qualidade|talento|defeito|pior|especial|superpoder|conquista/.test(normalized)
                    ? 'qualities'
                    : 'general';

    const answers = {
        pets: {
            poetica: [
                'Talvez o Shadow e a Sky não saibam escrever isso, mas demonstram todos os dias, do jeitinho deles, como a sua presença faz parte do pequeno mundo que construíram juntos. 🐾',
                'Para o Shadow e a Sky, carinho mora nas coisas simples: na sua voz, na companhia e nos momentos que vocês compartilham. Isso já é uma história bonita.'
            ],
            engracada: [
                'Comunicado oficial dos fiscais peludos: Sarah está aprovada como fornecedora de carinho. O Shadow exige petiscos; a Sky solicita mais atenção. 😂',
                'Shadow e Sky provavelmente diriam: “Ela é ótima! Só precisamos discutir o atraso na entrega dos petiscos.”'
            ],
            normal: [
                'O Shadow e a Sky provavelmente associam você a cuidado, companhia e rotina. Para eles, muitos dos melhores momentos são justamente os que passam ao seu lado. ♡',
                'Você e os dois já têm algo muito especial: uma coleção de pequenos momentos que, juntos, viram lembranças queridas.'
            ]
        },
        smile: {
            poetica: [
                'Que hoje você encontre pelo menos um motivo pequeno para sorrir. Nem todo dia precisa ser extraordinário para guardar um instante bonito.',
                'Às vezes, a alegria chega baixinho: numa música, numa lembrança, numa brincadeira ou em duas patinhas caminhando por perto. Que ela encontre espaço no seu dia.'
            ],
            engracada: [
                'Missão do dia: sorrir pelo menos uma vez. Se falhar, solicite suporte ao departamento de fofura, composto por Shadow e Sky. 😂',
                'Alerta: foi detectada uma Sarah precisando de +10 pontos de alegria. Recompensa disponível: música boa, carinho nos gatos e uma pausa para respirar.'
            ],
            normal: [
                'Você não precisa resolver tudo hoje. Escolha uma coisa simples que te faça bem, dê um espacinho para ela e vá no seu ritmo. Espero que seu dia fique mais leve. ♡',
                'Talvez um sorriso venha de algo pequeno: uma música de que você gosta, uma conversa boa ou um momento com o Shadow e a Sky. Você merece essas pausas.'
            ]
        },
        beauty: {
            poetica: [
                'A beleza não cabe em uma fotografia nem em uma medida. Ela também aparece no jeito de ser, nas pequenas escolhas e na forma particular de iluminar os próprios dias.',
                'Existe uma beleza que não precisa de comparação: aquela que nasce da sua individualidade e das partes da sua história que só você pode escrever.'
            ],
            engracada: [
                'O departamento de elogios analisou a pergunta e entrou em reunião extraordinária. Resultado: comparação com outras pessoas foi proibida por falta de necessidade. 😂',
                'A pergunta foi encaminhada ao Comitê Oficial de Autoestima. A resposta: parecer especial não depende de votação, e o Shadow já encerrou a reunião deitando em cima do documento.'
            ],
            normal: [
                'Você não precisa se comparar com ninguém para reconhecer seu valor. Sua aparência e seu jeito são seus, e merecem ser tratados com carinho, inclusive por você.',
                'Espero que você consiga olhar para si com gentileza. Você não precisa atender a um padrão para merecer se sentir bem consigo mesma.'
            ]
        },
        qualities: {
            poetica: [
                'Talvez uma das qualidades mais bonitas seja continuar descobrindo quem você é. Há coragem em crescer sem precisar ter todas as respostas agora.',
                'Você é uma história em construção. Cada detalhe, aprendizado e pequena conquista ajuda a formar alguém que não precisa ser igual a mais ninguém.'
            ],
            engracada: [
                'Seu superpoder oficial pode ser convocar gatos com um pensamento. Efeito colateral: eles aparecem, ignoram suas ordens e dominam o sofá. 😂',
                'Seu currículo acaba de ganhar uma habilidade: transformar perguntas aleatórias em conversas com uma IA que trabalha sob supervisão felina.'
            ],
            normal: [
                'Uma qualidade importante é estar sempre em processo de descoberta. Você pode reconhecer seus pontos fortes sem precisar ser perfeita ou saber tudo.',
                'Não diminua as pequenas coisas que faz. Aprender, tentar de novo, cuidar de quem importa e respeitar seu próprio ritmo também são qualidades.'
            ]
        },
        general: {
            poetica: [
                'Sarah, que você encontre beleza nos detalhes, coragem para seguir no seu ritmo e motivos inesperados para sorrir. Sua história merece gentileza, inclusive nos dias comuns. ♡',
                'Há muitas maneiras de tornar um dia especial: uma música, uma lembrança, uma risada ou um carinho de quatro patas. Que alguma delas encontre você hoje.'
            ],
            engracada: [
                'Resposta calculada por uma IA com três neurônios, dois cafés virtuais e supervisão rigorosa do Shadow e da Sky: você merece um dia excelente. 😂',
                'Sarah, você desbloqueou +10 pontos de fofura, +5 de bom humor e uma missão secundária: receber carinho dos gatos. Recompensa lendária!'
            ],
            normal: [
                'Sarah, lembre-se de reservar um pouco de carinho para você também. Você merece momentos tranquilos, boas risadas e coisas que façam sentido para sua vida. ♡',
                'Espero que este cantinho deixe seu dia um pouquinho mais leve. Vá no seu ritmo, aproveite as pequenas coisas e não se esqueça de cuidar de você.'
            ]
        }
    };

    const choices = answers[topic][style] || answers.general.normal;
    return choices[Math.floor(Math.random() * choices.length)];
}

// Respostas exclusivas do modo Rafael. Não usam OpenAI e não dependem do
// conteúdo da pergunta: a IA nunca se passa por ele nem tenta adivinhar sua resposta.
const RAFAEL_MODE_RESPONSES = Object.freeze([
    'Essa resposta eu não vou roubar do Rafael. 😌 Se quiser saber o que ele pensa, essa pergunta é diretamente com ele.',
    'Opa, essa está protegida! 🔒 Não vou falar por ele. Pergunta ao Rafael quando sentir vontade.',
    'Eu poderia tentar adivinhar, mas não seria justo. Essa resposta tem que vir do próprio Rafael. 👀',
    'Segredo do Rafael! 🤫 Não vou roubar as palavras dele. Se quiser, conta para ele o que você está pensando.',
    'Essa é daquelas perguntas que merecem uma resposta original, não uma imitação de IA. Essa fica com o Rafael. ♡',
    'Não vou me passar pelo Rafael, não! 😂 Essa resposta é exclusiva dele.',
    'Meu sistema detectou uma pergunta reservada ao Rafael. Você pode conversar com ele diretamente, sem pressa. ♡',
    'Essa resposta está no cofre do Rafael. 🔐 Só ele pode abrir — quando você quiser perguntar.',
    'Não vou roubar a chance do Rafael de responder pessoalmente. 😌',
    'Essa fica entre você e o Rafael. Eu sou só a guardiã das respostas que ainda não chegaram. 🤭',
    'Tenho uma regra: não falar por ele. Mas você pode contar diretamente o que quer saber, se quiser.',
    'Resposta indisponível para esta IA. Motivo: Rafael tem que falar por si mesmo. 😂'
]);

function chooseRafaelModeAnswer() {
    const index = Math.floor(Math.random() * RAFAEL_MODE_RESPONSES.length);
    return RAFAEL_MODE_RESPONSES[index];
}

async function generateOpenAiAnswer(question, style) {
    if (!OPENAI_API_KEY) return null;

    const styleInstructions = {
        poetica: 'Responda de forma poética, delicada, bonita e acolhedora, sem exagerar no romantismo.',
        engracada: 'Responda com humor leve, criatividade e brincadeiras carinhosas. Pode usar o Shadow e a Sky como personagens quando fizer sentido.',
        normal: 'Responda de maneira natural, simples, calorosa e direta.'
    };

    const systemPrompt = [
        'Você é a Mini IA do Cantinho da Sarah. Seu propósito é alegrar o dia da Sarah com respostas gentis, positivas, respeitosas e divertidas.',
        'Converse sempre em português brasileiro e chame a pessoa de Sarah quando soar natural.',
        'O assunto deste espaço é a própria Sarah, suas qualidades, sua autoestima, suas ideias, seus momentos e seus gatos Shadow e Sky.',
        'Contexto confirmado: Sarah tem dois gatos chamados Shadow e Sky. Não invente aparência, idade, profissão, gostos, conquistas, relacionamentos ou acontecimentos pessoais que não tenham sido fornecidos.',
        'Se a pergunta não for sobre Sarah ou sobre este cantinho, redirecione com delicadeza para algo sobre ela.',
        'Nunca responda com humilhação, crueldade, deboche, pressão emocional ou comparações depreciativas. Não faça diagnósticos nem prometa resolver problemas sérios.',
        'Se ela perguntar sobre defeitos, reconheça que ninguém é perfeito e responda com equilíbrio e gentileza, sem inventar defeitos específicos.',
        'Não afirme conhecer sentimentos ou pensamentos dos gatos como fatos; use linguagem de brincadeira ou possibilidade.',
        'Mantenha a resposta curta ou média, normalmente entre 2 e 5 frases. Não use títulos nem listas, a menos que a pergunta peça.',
        `Estilo escolhido: ${styleInstructions[style]}`
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);

    try {
        const response = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: question }
                ],
                temperature: 0.85,
                max_tokens: 260
            }),
            signal: controller.signal
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const apiMessage = payload?.error?.message || `A API de IA respondeu com status ${response.status}.`;
            throw new Error(apiMessage);
        }

        const answer = payload?.choices?.[0]?.message?.content;
        if (typeof answer !== 'string' || !answer.trim()) {
            throw new Error('A IA não retornou uma resposta em texto.');
        }
        return answer.trim().slice(0, 1800);
    } finally {
        clearTimeout(timeout);
    }
}

// -----------------------------------------------------------------------------
// CONFIGURAÇÃO DO UPLOAD
// -----------------------------------------------------------------------------

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PHOTO_SIZE_BYTES,
        files: MAX_PHOTOS_PER_UPLOAD,
        fields: 3,
        fieldSize: 2048,
        parts: MAX_PHOTOS_PER_UPLOAD + 3
    },
    fileFilter: (_req, file, callback) => {
        const extension = path.extname(file.originalname || '').slice(1).toLowerCase();
        const knownExtension = ALLOWED_IMAGE_TYPES.has(extension);
        const mimeLooksLikeImage = typeof file.mimetype === 'string' && file.mimetype.startsWith('image/');
        if (!knownExtension || !mimeLooksLikeImage) {
            return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photos'));
        }
        callback(null, true);
    }
});

// -----------------------------------------------------------------------------
// API: MINI IA
// -----------------------------------------------------------------------------

app.post('/api/mini-ia', aiLimiter, async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const style = typeof req.body?.style === 'string' ? req.body.style.trim().toLowerCase() : 'normal';
    const allowedStyles = new Set(['poetica', 'engracada', 'normal']);

    if (!question) return sendError(res, 400, 'Escreva uma pergunta antes de enviar. ♡');
    if (question.length > 500) return sendError(res, 400, 'A pergunta deve ter no máximo 500 caracteres.');

    // O modo Rafael é determinístico quanto à regra: qualquer pergunta válida
    // recebe uma resposta fixa aleatória, sem chamar o provedor de IA.
    if (style === 'rafael') {
        return res.json({ answer: chooseRafaelModeAnswer(), mode: 'rafael' });
    }

    if (!allowedStyles.has(style)) return sendError(res, 400, 'Escolha um dos três estilos de resposta.');

    try {
        let answer = null;
        let mode = 'local';
        if (OPENAI_API_KEY) {
            try {
                answer = await generateOpenAiAnswer(question, style);
                if (answer) mode = 'openai';
            } catch (error) {
                // A experiência continua disponível mesmo se a API externa falhar.
                console.warn('[Mini IA] A API externa falhou; usando resposta local:', error.message);
            }
        }

        if (!answer) answer = fallbackAiAnswer(question, style);
        return res.json({ answer, mode });
    } catch (error) {
        console.error('[Mini IA] Erro inesperado:', error);
        return sendError(res, 500, 'A Mini IA ficou pensando demais. Tente novamente daqui a pouquinho. ♡');
    }
});

// -----------------------------------------------------------------------------
// API: LISTAR FOTOS
// -----------------------------------------------------------------------------

app.get('/api/album', albumReadLimiter, async (_req, res) => {
    if (!requireAlbumBackend(res)) return;

    try {
        const { data, error } = await supabase
            .from('album_photos')
            .select('id, pet, caption, storage_path, created_at')
            .order('created_at', { ascending: false })
            .limit(500);

        if (error) throw error;
        const rows = Array.isArray(data) ? data : [];
        const photos = await Promise.all(rows.map(createSignedPhoto));
        return res.json({ photos });
    } catch (error) {
        console.error('[Álbum] Erro ao listar fotos:', error.message);
        return sendError(res, 502, `Não foi possível carregar as fotos.${getSupabaseSetupHint(error)}`);
    }
});

// -----------------------------------------------------------------------------
// API: ENVIAR FOTOS
// -----------------------------------------------------------------------------

app.post('/api/album/upload', albumWriteLimiter, (req, res, next) => {
    if (!requireAlbumBackend(res)) return;
    upload.array('photos', MAX_PHOTOS_PER_UPLOAD)(req, res, (error) => {
        if (error) return next(error);
        next();
    });
}, async (req, res) => {

    const pet = typeof req.body?.pet === 'string' ? req.body.pet.trim().toLowerCase() : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 250) : '';
    const files = Array.isArray(req.files) ? req.files : [];

    if (!['shadow', 'sky'].includes(pet)) {
        return sendError(res, 400, 'Selecione se a foto é do Shadow ou da Sky.');
    }
    if (files.length === 0) return sendError(res, 400, 'Escolha pelo menos uma foto para enviar.');
    if (files.length > MAX_PHOTOS_PER_UPLOAD) {
        return sendError(res, 400, `Envie no máximo ${MAX_PHOTOS_PER_UPLOAD} fotos por vez.`);
    }

    const uploadedPaths = [];
    try {
        const preparedRows = [];
        const now = new Date();
        const folder = `${pet}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

        // Confere o conteúdo real do arquivo. A extensão e o MIME enviados pelo
        // navegador, sozinhos, não são suficientes para validar uma imagem.
        for (const file of files) {
            const detected = await fileTypeFromBuffer(file.buffer);
            const imageType = detected ? ALLOWED_IMAGE_TYPES.get(detected.ext.toLowerCase()) : null;
            if (!imageType || !detected.mime.startsWith('image/')) {
                throw new Error(`O arquivo "${file.originalname}" não parece ser uma imagem JPG, PNG, WEBP ou HEIC válida.`);
            }

            const storagePath = `${folder}/${randomUUID()}.${imageType.extension}`;
            const { error: uploadError } = await supabase.storage
                .from(SUPABASE_STORAGE_BUCKET)
                .upload(storagePath, file.buffer, {
                    contentType: imageType.mime,
                    cacheControl: '31536000',
                    upsert: false
                });

            if (uploadError) throw uploadError;
            uploadedPaths.push(storagePath);

            preparedRows.push({
                pet,
                caption,
                storage_path: storagePath
            });
        }

        const { data, error: insertError } = await supabase
            .from('album_photos')
            .insert(preparedRows)
            .select('id, pet, caption, storage_path, created_at');

        if (insertError) throw insertError;

        const photos = await Promise.all((data || []).map(createSignedPhoto));
        return res.status(201).json({ photos, message: 'Fotos adicionadas ao álbum. ♡' });
    } catch (error) {
        // Se a gravação no banco falhar, apaga os arquivos que já chegaram ao
        // Storage, evitando deixar imagens órfãs na nuvem.
        if (uploadedPaths.length > 0 && supabase) {
            const { error: cleanupError } = await supabase.storage
                .from(SUPABASE_STORAGE_BUCKET)
                .remove(uploadedPaths);
            if (cleanupError) console.error('[Álbum] Falha na limpeza dos uploads:', cleanupError.message);
        }

        console.error('[Álbum] Erro no upload:', error.message);
        const status = error.message?.includes('não parece ser uma imagem') ? 400 : 502;
        return sendError(res, status, `${error.message || 'Não foi possível enviar as fotos.'}${getSupabaseSetupHint(error)}`);
    }
});

// -----------------------------------------------------------------------------
// API: EXCLUIR FOTO
// -----------------------------------------------------------------------------

app.delete('/api/album/:id', albumWriteLimiter, async (req, res) => {
    if (!requireAlbumBackend(res)) return;

    if (!ALBUM_ADMIN_PASSWORD) {
        return sendError(res, 503, 'A exclusão está desativada até configurar ALBUM_ADMIN_PASSWORD no arquivo .env.');
    }

    const suppliedPassword = req.get('x-album-admin-password') || '';
    if (!safeEqualStrings(suppliedPassword, ALBUM_ADMIN_PASSWORD)) {
        return sendError(res, 401, 'Senha de gerenciamento incorreta. A foto não foi removida.');
    }

    const photoId = String(req.params.id || '').trim();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(photoId)) return sendError(res, 400, 'Identificador de foto inválido.');

    try {
        const { data: photo, error: findError } = await supabase
            .from('album_photos')
            .select('id, storage_path')
            .eq('id', photoId)
            .maybeSingle();

        if (findError) throw findError;
        if (!photo) return sendError(res, 404, 'Essa foto não foi encontrada no álbum.');

        const { error: storageError } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .remove([photo.storage_path]);
        if (storageError) throw storageError;

        const { error: deleteError } = await supabase
            .from('album_photos')
            .delete()
            .eq('id', photoId);
        if (deleteError) throw deleteError;

        return res.json({ success: true, message: 'Foto removida do álbum. ♡' });
    } catch (error) {
        console.error('[Álbum] Erro ao excluir foto:', error.message);
        return sendError(res, 502, `Não foi possível remover a foto.${getSupabaseSetupHint(error)}`);
    }
});

// -----------------------------------------------------------------------------
// SAÚDE E TRATAMENTO DE ERROS
// -----------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        app: 'cantinho-da-sarah',
        supabaseConfigured: isSupabaseConfigured(),
        aiConfigured: Boolean(OPENAI_API_KEY),
        timestamp: new Date().toISOString()
    });
});

app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return sendError(res, 413, 'Cada foto pode ter no máximo 15 MB.');
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return sendError(res, 413, `Envie no máximo ${MAX_PHOTOS_PER_UPLOAD} fotos por vez.`);
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return sendError(res, 400, 'Um dos arquivos não foi reconhecido como imagem válida. Use JPG, PNG, WEBP ou HEIC.');
        }
        return sendError(res, 400, 'Os arquivos enviados não puderam ser processados.');
    }

    if (error?.type === 'entity.too.large') {
        return sendError(res, 413, 'O envio ultrapassou o limite permitido. Reduza a quantidade ou o tamanho das fotos.');
    }

    if (error?.status === 404) {
        return sendError(res, 404, 'Arquivo ou rota não encontrada.');
    }

    console.error('[Servidor] Erro não tratado:', error);
    return sendError(res, 500, 'Ocorreu um erro interno. Tente novamente.');
});

// -----------------------------------------------------------------------------
// INICIALIZAÇÃO
// -----------------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
    console.log('');
    console.log('♡ Cantinho da Sarah está no ar!');
    console.log(`   Endereço local: http://localhost:${PORT}`);
    console.log(`   Supabase: ${isSupabaseConfigured() ? 'configurado' : 'aguardando .env'}`);
    console.log(`   Mini IA: ${OPENAI_API_KEY ? `API externa (${OPENAI_MODEL})` : 'respostas locais de contingência'}`);
    console.log('');
});

function shutdown(signal) {
    console.log(`\n[Servidor] ${signal} recebido. Encerrando com segurança...`);
    server.close((error) => {
        if (error) {
            console.error('[Servidor] Erro ao encerrar:', error);
            process.exit(1);
        }
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
