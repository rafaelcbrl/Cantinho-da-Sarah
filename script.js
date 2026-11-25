/* ============================================================================
   CANTINHO DA SARAH — SCRIPT.JS
   ---------------------------------------------------------------------------
   Este arquivo controla as interações do site:
   - Menu de navegação responsivo;
   - Mini IA com estilos Poética, Engraçada e Normal;
   - Prisão interativa;
   - Filtros e surpresa das 12 cantadas;
   - Player musical que continua tocando durante a navegação pelas seções;
   - Álbum do Shadow e da Sky, com pré-visualização, envio, galeria e exclusão.

   ROTAS QUE SERÃO IMPLEMENTADAS NO server.js:
   1) POST   /api/mini-ia
      JSON enviado: { question: string, style: "poetica" | "engracada" | "normal" }
      JSON esperado: { answer: string }

   2) GET    /api/album
      JSON esperado: { photos: [{ id, pet, url, caption, createdAt }] }

   3) POST   /api/album/upload
      multipart/form-data: pet, caption e um ou mais campos "photos"
      JSON esperado: { photos: [...] }

   4) DELETE /api/album/:id
      Cabeçalho esperado: x-album-admin-password: <senha de gerenciamento>

   IMPORTANTE:
   - A Mini IA tem respostas locais de contingência enquanto a rota real de IA
     ainda não existir. Para respostas realmente abertas e contextualizadas,
     o server.js precisará chamar um provedor de IA usando uma chave guardada
     somente no ambiente do servidor.
   - As credenciais do Supabase nunca devem ficar neste arquivo nem no HTML.
   - O álbum não finge salvar fotos: uploads só serão confirmados quando a API
     do servidor retornar sucesso.
   ============================================================================ */

(() => {
    'use strict';

    const CONFIG = Object.freeze({
        aiEndpoint: '/api/mini-ia',
        albumEndpoint: '/api/album',
        albumUploadEndpoint: '/api/album/upload',
        albumDeleteEndpoint: (id) => `/api/album/${encodeURIComponent(id)}`,
        maxImageSizeBytes: 15 * 1024 * 1024,
        uploadTimeoutMs: 120000,
        albumDeletePasswordHeader: 'x-album-admin-password'
    });

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    const escapeHtmlText = (value) => String(value ?? '');

    function setHidden(element, hidden) {
        if (!element) return;
        element.hidden = Boolean(hidden);
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const total = Math.floor(seconds);
        const minutes = Math.floor(total / 60);
        const remainingSeconds = total % 60;
        return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
    }

    function formatDate(dateValue) {
        if (!dateValue) return 'Lembrança guardada';
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) return 'Lembrança guardada';
        return new Intl.DateTimeFormat('pt-BR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        }).format(date);
    }

    function safeMediaUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return '';
        const candidate = value.trim();

        // Permite caminhos relativos do próprio site e URLs HTTP/HTTPS.
        // Bloqueia javascript:, data: e demais esquemas não esperados.
        if (/^(https?:\/\/|\/|\.\/|\.\.\/)/i.test(candidate)) {
            try {
                const parsed = new URL(candidate, window.location.origin);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    return candidate;
                }
            } catch (error) {
                console.warn('URL de mídia inválida:', error);
            }
        }
        return '';
    }

    function getApiErrorMessage(payload, fallback) {
        if (payload && typeof payload.message === 'string' && payload.message.trim()) {
            return payload.message.trim();
        }
        if (payload && typeof payload.error === 'string' && payload.error.trim()) {
            return payload.error.trim();
        }
        return fallback;
    }

    async function readJsonResponse(response) {
        const text = await response.text();
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch (error) {
            return { message: text.slice(0, 300) };
        }
    }

    /* ========================================================================
       1. MENU DE NAVEGAÇÃO
       ======================================================================== */

    function initNavigation() {
        const menuButton = $('#menu-toggle');
        const navigation = $('#main-navigation');
        if (!menuButton || !navigation) return;

        const closeMenu = () => {
            navigation.classList.remove('is-open');
            menuButton.setAttribute('aria-expanded', 'false');
            menuButton.setAttribute('aria-label', 'Abrir menu de navegação');
        };

        menuButton.addEventListener('click', () => {
            const willOpen = !navigation.classList.contains('is-open');
            navigation.classList.toggle('is-open', willOpen);
            menuButton.setAttribute('aria-expanded', String(willOpen));
            menuButton.setAttribute(
                'aria-label',
                willOpen ? 'Fechar menu de navegação' : 'Abrir menu de navegação'
            );
        });

        $$('.main-navigation__link', navigation).forEach((link) => {
            link.addEventListener('click', closeMenu);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenu();
        });

        document.addEventListener('click', (event) => {
            if (!navigation.classList.contains('is-open')) return;
            const clickedInside = navigation.contains(event.target) || menuButton.contains(event.target);
            if (!clickedInside) closeMenu();
        });
    }

    /* ========================================================================
       2. MINI IA
       ======================================================================== */

    const localAnswers = {
        special: {
            poetica: [
                'Porque algumas pessoas têm um jeito único de deixar o mundo mais bonito sem nem perceber. Você é uma dessas pessoas, Sarah. ♡',
                'O especial em você não cabe em uma única palavra: está no seu jeito, nas pequenas atitudes e na marca bonita que deixa por onde passa.',
                'Há pessoas que parecem carregar um pedacinho de luz consigo. Não precisam fazer barulho para serem notadas. Você tem esse encanto.'
            ],
            engracada: [
                'Fiz uma análise supercientífica: 99,9% de charme, 0,1% de mistério e uma quantidade de fofura que fez minha calculadora pedir férias. 😂',
                'Você é tão especial que, quando tentaram fabricar outra igual, a máquina mostrou: “modelo exclusivo, sem reposição”.',
                'Porque o universo só tinha orçamento para uma Sarah. E, sinceramente, já foi um investimento de sucesso. 😂'
            ],
            normal: [
                'Porque você tem seu próprio jeito de ser, de demonstrar carinho e de tornar os momentos mais leves. Não precisa ser igual a ninguém para ser especial.',
                'Você é especial pelas suas características, pelas coisas que gosta e pela forma como constrói suas relações. Isso não precisa de comparação.',
                'Porque existe muita coisa boa no seu jeito de ser, Sarah. Às vezes a gente só precisa parar um pouquinho para reconhecer isso.'
            ]
        },
        smile: {
            poetica: [
                'Hoje ainda pode guardar uma surpresa pequena e bonita. Que você encontre um motivo para sorrir, mesmo que seja no detalhe mais simples do dia. ♡',
                'Nem todo dia precisa ser extraordinário. Às vezes, um raio de sol, uma música querida e um carinho dos seus companheiros já fazem florescer um sorriso.',
                'Que hoje a vida seja gentil com você e que, entre uma coisa e outra, apareça um instante que faça seu coração descansar.'
            ],
            engracada: [
                'Ordem oficial da Mini IA: sorrir pelo menos uma vez hoje. A fiscalização será feita por dois supervisores peludos chamados Shadow e Sky. 😂',
                'Porque seu sorriso é uma atualização importante do sistema. Sem ele, o dia fica em modo economia de energia.',
                'Recomendação médica da minha equipe imaginária: uma dose de música, duas doses de carinho nos pets e um sorriso. Repetir se necessário.'
            ],
            normal: [
                'Porque você merece ter momentos bons, mesmo quando o dia está corrido. Tente reservar um tempinho para algo de que gosta e para ficar com a Sky e o Shadow.',
                'Você não precisa ter tudo resolvido para encontrar um motivo para sorrir. Um momento tranquilo já pode mudar o ritmo do dia.',
                'Porque sempre vale a pena dar uma chance às coisas boas que ainda podem acontecer hoje. Espero que uma delas encontre você.'
            ]
        },
        beautiful: {
            poetica: [
                'A beleza também mora na maneira como alguém olha o mundo, nas expressões espontâneas e no brilho que aparece quando fala do que ama. ♡',
                'Há uma beleza que não depende de espelho: ela aparece no riso sincero, na delicadeza dos gestos e na autenticidade de ser quem se é.',
                'Você não precisa caber em padrão algum. Sua beleza pode ser simplesmente sua: singular, própria e impossível de resumir.'
            ],
            engracada: [
                'O espelho pediu para eu avisar que está trabalhando sob pressão. Toda vez que você aparece, ele precisa recalcular o brilho. 😂',
                'A NASA ainda não confirmou, mas há suspeitas de que seu nível de beleza seja visível em imagens de satélite.',
                'Você é bonita, sim. Fonte: meus cálculos, três planilhas, uma pesquisa imaginária e a opinião altamente suspeita do Shadow.'
            ],
            normal: [
                'Você não precisa ficar se comparando com outras pessoas. Beleza tem muitas formas, e o mais importante é se sentir bem consigo mesma.',
                'Sim, você merece se olhar com carinho. Não deixe um dia ruim ou uma comparação injusta definir como você enxerga a si mesma.',
                'Você tem sua própria beleza, Sarah. E ela não precisa ser medida pela régua de ninguém.'
            ]
        },
        quality: {
            poetica: [
                'Uma qualidade bonita é a capacidade de tornar pequenos instantes importantes. Talvez você nem perceba quando faz isso, mas gestos simples também deixam lembranças.',
                'A sua singularidade está nas pequenas partes que formam quem você é: seus gostos, sua sensibilidade, seu humor e o jeito próprio de caminhar pelo mundo.',
                'Uma qualidade pode ser silenciosa: a forma como você se importa, como aprende e como continua sendo você em meio aos dias diferentes.'
            ],
            engracada: [
                'Seu maior talento é ser protagonista até quando só queria ficar quietinha. O roteiro tenta te colocar de figurante, mas você não colabora. 😂',
                'Você tem uma habilidade rara: fazer a IA parar o que está fazendo para montar uma resposta caprichada.',
                'Seu carisma está tão forte que até o corretor automático quer puxar assunto.'
            ],
            normal: [
                'Uma qualidade importante é ter interesses e características que fazem parte de quem você é. Pense também nas coisas que as pessoas próximas valorizam em você.',
                'Você pode reconhecer qualidades no seu jeito de cuidar, aprender, criar, ouvir ou fazer as pessoas rirem. Não precisa escolher só uma.',
                'Talvez uma das suas qualidades seja justamente ter um jeito próprio. Vale a pena reconhecer as pequenas coisas que você faz bem.'
            ]
        },
        flaw: {
            poetica: [
                'Talvez você seja exigente demais consigo mesma em alguns dias. Mas até quem tem o coração cheio de planos merece descansar e se tratar com ternura.',
                'Se existe algo a melhorar, que seja sem apagar sua luz. Crescer não significa se tornar outra pessoa; significa aprender a cuidar melhor de si.',
                'Não transforme suas imperfeições em uma sentença. Elas são apenas partes da história de alguém que ainda está descobrindo tanta coisa.'
            ],
            engracada: [
                'Seu pior defeito? Ainda não encontrei. Meu sistema está procurando há tanto tempo que já pediu café e um vale-refeição. 😂',
                'Talvez seja ter dois fiscais peludos em casa e ainda não ter criado um departamento oficial de distribuição de petiscos.',
                'Você pensa demais às vezes? Bem-vinda ao clube. A mensalidade é grátis, mas a mente não fecha para manutenção.'
            ],
            normal: [
                'Não tenho como definir seu pior defeito sem conhecer tudo sobre você. Todo mundo tem pontos para desenvolver, e isso não diminui seu valor.',
                'Talvez existam situações em que você seja muito exigente consigo mesma. Tente olhar para seus erros com a mesma compreensão que ofereceria a alguém de quem gosta.',
                'Em vez de procurar um defeito para se cobrar, pode ser mais útil pensar em algo que você gostaria de desenvolver com calma.'
            ]
        },
        pets: {
            poetica: [
                'O Shadow e a Sky talvez não usem palavras, mas deixam carinho em cada companhia silenciosa, cada brincadeira e cada momento perto de você. 🐾',
                'Para dois corações de patinhas, você é parte do lugar onde a vida acontece: o aconchego, a rotina e os pequenos momentos que viram lembrança.',
                'Se o amor pudesse miar, provavelmente os dois já teriam contado muitas histórias sobre você.'
            ],
            engracada: [
                'Shadow: “Ela é minha funcionária favorita.” Sky: “Concordo, desde que o salário venha em sachê.” 😂',
                'Relatório oficial dos pets: Sarah aprovada como fornecedora de carinho, entretenimento e serviço de abertura de portas.',
                'Os dois provavelmente diriam: “Gostamos dela. Mas gostaríamos de registrar que o horário dos petiscos está atrasado.”'
            ],
            normal: [
                'O Shadow e a Sky provavelmente associam você a cuidado, companhia e rotina. Para eles, os momentos simples ao seu lado podem ser os mais importantes.',
                'Eles têm sorte de fazer parte da sua vida. E você também tem sorte de contar com dois companheiros tão especiais.',
                'Você pode criar muitas lembranças bonitas com os dois: brincadeiras, fotos, carinho e até aqueles momentos engraçados do dia a dia.'
            ]
        },
        superpower: {
            poetica: [
                'Seu superpoder seria transformar pequenos instantes em lembranças queridas: fazer alguém se sentir acolhido e encontrar beleza no que parece simples.',
                'Talvez fosse espalhar leveza. Não como quem resolve todos os problemas, mas como quem lembra que ainda existe beleza no caminho.',
                'Você teria o poder de acender pequenas luzes nos dias comuns. Um dom discreto, mas capaz de mudar a atmosfera de um lugar.'
            ],
            engracada: [
                'Seu superpoder seria invocar gatos instantaneamente. Limitação: eles só obedecem quando querem. Ou seja, poder praticamente ilimitado. 😂',
                'Você teria o poder de encontrar o último petisco escondido da casa. Nem o Shadow conseguiria competir.',
                'Poder especial desbloqueado: fazer qualquer ambiente virar um episódio de comédia sem perceber.'
            ],
            normal: [
                'Eu escolheria o poder de espalhar alegria. Combina com a ideia deste cantinho: deixar os dias um pouco mais leves para você e para quem está por perto.',
                'Talvez você fosse uma personagem com o poder de entender os animais. O Shadow e a Sky seriam seus primeiros parceiros de equipe.',
                'Seu superpoder poderia ser transformar momentos comuns em lembranças boas. É um poder simples, mas muito valioso.'
            ]
        },
        achievement: {
            poetica: [
                'Cada passo que você dá, mesmo quando parece pequeno, faz parte de uma história que merece ser reconhecida. Não diminua o caminho que já percorreu.',
                'Há conquistas que fazem barulho e outras que só você conhece. Todas podem ter valor quando representam esforço, coragem ou crescimento.',
                'Olhe para trás com carinho: você já atravessou dias que pareciam difíceis e chegou até aqui. Isso também merece ser celebrado.'
            ],
            engracada: [
                'Sua conquista de hoje pode ser sobreviver à agenda, alimentar os fiscais peludos e ainda encontrar tempo para existir. Medalha entregue! 🏅',
                'Conquista desbloqueada: chegou até aqui e ainda teve energia para conversar com uma IA de autoestima duvidosa. Lendária.',
                'Não subestime as pequenas vitórias. Até levantar da cama em um dia preguiçoso merece uma trilha sonora épica.'
            ],
            normal: [
                'Mesmo quando você não percebe, continuar aprendendo e tentando já é importante. Vale reconhecer tanto as grandes conquistas quanto os passos pequenos.',
                'Uma conquista não precisa ser enorme para ter significado. Pense no que você aprendeu, superou ou fez com dedicação recentemente.',
                'Você merece reconhecer o próprio esforço. Não precisa esperar alguém notar para valorizar algo que foi importante para você.'
            ]
        },
        default: {
            poetica: [
                'Sarah, que você nunca se esqueça de que sua história merece cuidado, suas alegrias merecem espaço e seus dias também podem florescer em detalhes pequenos. ♡',
                'Há muito de bonito nas coisas que fazem você ser você. Continue descobrindo seus caminhos, respeitando seu tempo e guardando espaço para o que te faz bem.',
                'Que a vida te encontre com gentileza hoje. E que você também consiga olhar para si com a mesma delicadeza.'
            ],
            engracada: [
                'Resposta calculada por uma IA com 3 neurônios, 2 cafés virtuais e supervisão do Shadow e da Sky: você merece um dia excelente. 😂',
                'Sarah, você desbloqueou uma resposta especial! Recompensa: +10 de autoestima, +5 de fofura e uma missão diária de fazer carinho nos pets.',
                'O departamento de elogios analisou sua pergunta e decidiu: aprovada com louvor. Pode retirar seu certificado imaginário na recepção. 🏆'
            ],
            normal: [
                'Sarah, não se esqueça de reservar um pouco de carinho para você também. Você merece momentos tranquilos, boas risadas e coisas que façam sentido para sua vida.',
                'O mais importante é que você possa ser você mesma, respeitar seu próprio ritmo e reconhecer as coisas boas que existem na sua história.',
                'Espero que este cantinho tenha conseguido deixar seu dia um pouco mais leve. Você merece gentileza, inclusive da sua própria parte. ♡'
            ]
        }
    };

    const answerRotation = new Map();

    function normalizeText(value) {
        return String(value || '')
            .toLocaleLowerCase('pt-BR')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function classifyQuestion(question) {
        const text = normalizeText(question);
        if (/shadow|sky|gato|gata|pet|patinha|mi(u|a)/.test(text)) return 'pets';
        if (/superpoder|poder especial|poderia ter|habilidade magica/.test(text)) return 'superpower';
        if (/defeito|pior|erro|imperfeic|falha/.test(text)) return 'flaw';
        if (/conquista|orgulho|consegui|superei|vitoria|realizei/.test(text)) return 'achievement';
        if (/qualidade|melhor em mim|sou boa em|talento|dom/.test(text)) return 'quality';
        if (/bonita|linda|beleza|aparencia|bonito/.test(text)) return 'beautiful';
        if (/sorr|feliz|alegr|dia ruim|triste|animar|motivo/.test(text)) return 'smile';
        if (/especial|diferente|importante|gosta de mim|valor/.test(text)) return 'special';
        return 'default';
    }

    function chooseRotatingAnswer(category, style) {
        const group = localAnswers[category] || localAnswers.default;
        const options = group[style] || group.normal;
        const key = `${category}:${style}`;
        const previousIndex = answerRotation.has(key) ? answerRotation.get(key) : -1;
        let nextIndex = Math.floor(Math.random() * options.length);

        if (options.length > 1 && nextIndex === previousIndex) {
            nextIndex = (nextIndex + 1) % options.length;
        }

        answerRotation.set(key, nextIndex);
        return options[nextIndex];
    }

    function addChatMessage(role, text, style = '') {
        const history = $('#ai-chat-history');
        if (!history) return;

        const article = document.createElement('article');
        article.className = `chat-message chat-message--${role}`;
        article.dataset.messageRole = role;

        const avatar = document.createElement('span');
        avatar.className = 'chat-message__avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = role === 'user' ? '♡' : '✦';

        const bubble = document.createElement('div');
        bubble.className = 'chat-message__bubble';

        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        bubble.appendChild(paragraph);
        article.append(avatar, bubble);

        if (style) article.dataset.responseStyle = style;
        history.appendChild(article);

        // Mantém o histórico leve para celulares e conversas longas.
        const messages = $$('[data-message-role]', history);
        while (messages.length > 42) {
            messages.shift().remove();
        }

        history.scrollTop = history.scrollHeight;
        return article;
    }

    function setAiBusy(isBusy) {
        const submitButton = $('#ai-submit-button');
        const question = $('#ai-question');
        if (submitButton) {
            submitButton.disabled = isBusy;
            const label = $('span', submitButton);
            if (label) label.textContent = isBusy ? 'Pensando...' : 'Enviar';
        }
        if (question) question.disabled = isBusy;
    }

    // Respostas fixas do modo Rafael. A pergunta é intencionalmente ignorada:
    // a Mini IA não tenta adivinhar nem falar em nome dele.
    function chooseRafaelModeAnswer() {
        const responses = [
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
        ];

        return responses[Math.floor(Math.random() * responses.length)];
    }

    async function requestAiAnswer(question, style) {
        // Tenta primeiro a rota segura do servidor. A chave do provedor de IA
        // ficará no server.js/.env, nunca no JavaScript do navegador.
        try {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 25000);
            const response = await fetch(CONFIG.aiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, style }),
                signal: controller.signal
            });
            window.clearTimeout(timeout);

            const payload = await readJsonResponse(response);
            if (response.ok) {
                const answer = payload.answer || payload.response || payload.message;
                if (typeof answer === 'string' && answer.trim()) return answer.trim();
            }
        } catch (error) {
            // Enquanto o endpoint ainda não existir, a resposta local mantém
            // a demonstração utilizável. Nenhuma pergunta é perdida ou enviada
            // para um serviço externo diretamente do navegador.
            console.info('Mini IA usando respostas locais de contingência:', error.message);
        }

        // Se a API estiver indisponível, o modo Rafael continua funcionando
        // sem recorrer às respostas normais nem tentar imitar a voz dele.
        if (style === 'rafael') return chooseRafaelModeAnswer();

        const category = classifyQuestion(question);
        return chooseRotatingAnswer(category, style);
    }

    function initMiniAI() {
        const form = $('#ai-form');
        const questionInput = $('#ai-question');
        const errorBox = $('#ai-error-message');
        if (!form || !questionInput) return;

        $$('.suggestion-chip[data-ai-suggestion]').forEach((button) => {
            button.addEventListener('click', () => {
                questionInput.value = button.dataset.aiSuggestion || '';
                questionInput.focus();
            });
        });

        questionInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                form.requestSubmit();
            }
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const question = questionInput.value.trim();
            const selectedStyle = $('input[name="ai-style"]:checked', form);
            const style = selectedStyle ? selectedStyle.value : 'normal';

            if (!question) {
                if (errorBox) {
                    errorBox.textContent = 'Escreva uma perguntinha sobre você antes de enviar. ♡';
                    setHidden(errorBox, false);
                }
                questionInput.focus();
                return;
            }

            if (question.length > 500) {
                if (errorBox) {
                    errorBox.textContent = 'Sua pergunta ficou um pouquinho longa. Tente resumir em até 500 caracteres.';
                    setHidden(errorBox, false);
                }
                return;
            }

            if (errorBox) setHidden(errorBox, true);
            addChatMessage('user', question);
            questionInput.value = '';
            setAiBusy(true);

            const typingMessage = addChatMessage('assistant', 'Estou preparando uma resposta com carinho...');
            if (typingMessage) typingMessage.classList.add('chat-message--typing');

            try {
                const answer = await requestAiAnswer(question, style);
                if (typingMessage) typingMessage.remove();
                addChatMessage('assistant', answer, style);
            } catch (error) {
                if (typingMessage) typingMessage.remove();
                addChatMessage(
                    'assistant',
                    'Ops, tive um pequeno tropeço. Tente perguntar de novo daqui a pouquinho. Enquanto isso, lembre-se: você merece gentileza. ♡',
                    style
                );
                console.error('Erro ao responder na Mini IA:', error);
            } finally {
                setAiBusy(false);
                questionInput.focus();
            }
        });
    }

    /* ========================================================================
       3. PRISÃO INTERATIVA
       ======================================================================== */

    function initPrisonGame() {
        const result = $('#prison-result');
        const resultTitle = $('#prison-result-title');
        const resultText = $('#prison-result-text');
        const closeButton = $('#prison-result-close');
        if (!result || !resultTitle || !resultText) return;

        const messages = {
            case: [
                'Prova A: testemunhas afirmam que a suspeita foi vista espalhando charme sem autorização. Prova B: o espelho solicitou reforço. Prova C: o Shadow e a Sky se recusaram a depor porque estavam ocupados recebendo carinho. 🐾',
                'Foram encontradas três evidências: um sorriso suspeito, uma quantidade incomum de fofura e um histórico de conquistar até os jurados. O caso parece grave... para a beleza do mundo.',
                'A perícia confirmou: excesso de encanto em primeiro grau. O laudo recomenda que a acusada continue sendo exatamente quem é.'
            ],
            appeal: [
                'O pedido foi analisado. A liberdade foi concedida imediatamente, pois a própria cela se recusou a manter uma pessoa tão simpática presa. Caso encerrado! ♡',
                'O juiz leu a ficha, olhou para a acusação e decidiu: “Não podemos prender a primeira maravilha do mundo”. Pedido aceito!',
                'Após uma longa reunião, o tribunal concluiu que a pena seria cruel demais para os responsáveis pela saudade: Shadow e Sky. Liberdade concedida!'
            ],
            surprise: [
                'SURPRESA: a detenta foi oficialmente promovida a patrimônio mundial do charme. A cela agora é um camarim e a chave foi entregue aos gatos. 😂',
                'Um comunicado urgente chegou: a prisão recebeu uma ordem de soltura assinada pelo Departamento Internacional de Pessoas Incríveis. Está livre!',
                'A cela pediu demissão. Motivo: não conseguiu manter a seriedade diante da primeira maravilha do mundo. Você está liberada! ✨'
            ]
        };

        const titles = {
            case: 'Novas provas encontradas!',
            appeal: 'Resultado do pedido de liberdade',
            surprise: 'Comunicado extraordinário!'
        };

        $$('[data-prison-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const action = button.dataset.prisonAction;
                if (!messages[action]) return;
                const options = messages[action];
                const chosen = options[Math.floor(Math.random() * options.length)];
                resultTitle.textContent = titles[action];
                resultText.textContent = chosen;
                setHidden(result, false);
                result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });

        closeButton?.addEventListener('click', () => setHidden(result, true));
    }

    /* ========================================================================
       4. CANTADAS — 7 VÍDEOS + 5 IMAGENS
       ======================================================================== */

    function initQuotes() {
        const cards = $$('[data-quote-id]');
        const filterButtons = $$('[data-quote-filter]');
        const surpriseButton = $('[data-random-quote]');
        const surpriseResult = $('#quote-surprise-result');
        const surpriseText = $('#quote-surprise-text');
        const surpriseClose = $('#quote-surprise-close');
        if (!cards.length) return;

        function applyFilter(filter) {
            cards.forEach((card) => {
                const shouldShow = filter === 'all' || card.dataset.quoteType === filter;
                card.hidden = !shouldShow;
                if (!shouldShow) {
                    const video = $('video', card);
                    if (video && !video.paused) video.pause();
                }
            });

            filterButtons.forEach((button) => {
                const active = button.dataset.quoteFilter === filter;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            });
        }

        filterButtons.forEach((button) => {
            button.addEventListener('click', () => applyFilter(button.dataset.quoteFilter || 'all'));
        });

        // Evita que dois vídeos toquem ao mesmo tempo.
        const quoteVideos = $$('video.quote-card__video');
        quoteVideos.forEach((video) => {
            video.addEventListener('play', () => {
                quoteVideos.forEach((otherVideo) => {
                    if (otherVideo !== video && !otherVideo.paused) otherVideo.pause();
                });
            });
        });

        surpriseButton?.addEventListener('click', () => {
            const selected = cards[Math.floor(Math.random() * cards.length)];
            if (!selected) return;

            const filter = selected.dataset.quoteType;
            applyFilter('all');
            const title = $('.quote-card__title', selected)?.textContent?.trim() || 'Uma cantada surpresa';
            const id = selected.dataset.quoteId || '';
            const number = id.split('-').pop();
            const kind = filter === 'video' ? 'vídeo' : 'imagem';

            if (surpriseText) {
                surpriseText.textContent = `A sorte escolheu: ${title} — ${kind} ${number}. ♡`;
            }
            if (surpriseResult) setHidden(surpriseResult, false);

            selected.scrollIntoView({ behavior: 'smooth', block: 'center' });
            selected.style.outline = '3px solid rgba(190, 120, 153, 0.75)';
            selected.style.outlineOffset = '5px';
            window.setTimeout(() => {
                selected.style.outline = '';
                selected.style.outlineOffset = '';
            }, 2600);

            if (filter === 'video') {
                const video = $('video', selected);
                if (video) {
                    const playAttempt = video.play();
                    if (playAttempt && typeof playAttempt.catch === 'function') {
                        playAttempt.catch(() => {
                            // A pessoa ainda pode iniciar pelo controle do vídeo.
                        });
                    }
                }
            }
        });

        surpriseClose?.addEventListener('click', () => {
            if (surpriseResult) setHidden(surpriseResult, true);
        });

        applyFilter('all');
    }

    /* ========================================================================
       5. PLAYER MUSICAL PERSISTENTE
       ======================================================================== */

    function initMusicPlayer() {
        const audio = $('#global-video-audio-player') || $('#global-audio-player');
        const trackButtons = $$('.music-track[data-track-src]');
        if (!audio || !trackButtons.length) return;

        const titleElement = $('#current-track-title');
        const artistElement = $('#current-track-artist');
        const progress = $('#music-progress-range');
        const currentTimeElement = $('#music-current-time');
        const durationElement = $('#music-duration');
        const volume = $('#music-volume-range');
        const playButton = $('#music-play-pause');
        const previousButton = $('#music-previous');
        const nextButton = $('#music-next');
        const artworkButton = $('#music-artwork-button');
        const persistentTitle = $('#persistent-track-title');
        const persistentPlayButton = $('#persistent-play-pause');
        const persistentPreviousButton = $('#persistent-previous');
        const persistentNextButton = $('#persistent-next');
        const videoMessageDialog = $('#music-video-message-dialog');

        let currentIndex = Math.max(0, trackButtons.findIndex((button) => button.classList.contains('is-selected')));
        let isSeeking = false;

        function getTrack(index) {
            const button = trackButtons[index];
            if (!button) return null;
            return {
                button,
                src: button.dataset.trackSrc || '',
                title: button.dataset.trackTitle || $('.music-track__title', button)?.textContent?.trim() || `Música ${index + 1}`,
                artist: button.dataset.trackArtist || $('.music-track__artist', button)?.textContent?.trim() || 'Artista a definir'
            };
        }

        function updateTrackInterface() {
            const track = getTrack(currentIndex);
            if (!track) return;

            if (titleElement) titleElement.textContent = track.title;
            if (artistElement && !audio.error) artistElement.textContent = track.artist;
            if (persistentTitle) persistentTitle.textContent = track.title;

            trackButtons.forEach((button, index) => {
                const active = index === currentIndex;
                button.classList.toggle('is-selected', active);
                button.setAttribute('aria-pressed', String(active));
                const icon = $('.music-track__play', button);
                if (icon) icon.textContent = active && !audio.paused ? 'Ⅱ' : '▶';
            });
        }

        function updatePlayButtons() {
            const playing = !audio.paused && !audio.ended;
            if (playButton) {
                playButton.textContent = playing ? 'Ⅱ' : '▶';
                playButton.setAttribute('aria-label', playing ? 'Pausar música' : 'Reproduzir música');
                playButton.title = playing ? 'Pausar' : 'Reproduzir';
            }
            if (persistentPlayButton) {
                persistentPlayButton.textContent = playing ? 'Ⅱ' : '▶';
                persistentPlayButton.setAttribute('aria-label', playing ? 'Pausar música' : 'Reproduzir música');
            }
            trackButtons.forEach((button, index) => {
                const icon = $('.music-track__play', button);
                if (icon) icon.textContent = index === currentIndex && playing ? 'Ⅱ' : '▶';
            });
        }

        function updateProgress() {
            if (!isSeeking && progress) {
                const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
                const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
                progress.value = duration > 0 ? String((current / duration) * 100) : '0';
            }
            if (currentTimeElement) currentTimeElement.textContent = formatDuration(audio.currentTime);
            if (durationElement) durationElement.textContent = formatDuration(audio.duration);
        }

        async function startPlayback() {
            try {
                await audio.play();
                updatePlayButtons();
            } catch (error) {
                updatePlayButtons();
                if (artistElement) {
                    artistElement.textContent = 'Adicione o arquivo de áudio correspondente em /musicas/.';
                }
                console.warn('Não foi possível iniciar a música:', error);
            }
        }

        function loadTrack(index, shouldPlay = false) {
            const normalizedIndex = (index + trackButtons.length) % trackButtons.length;
            const track = getTrack(normalizedIndex);
            if (!track) return;

            currentIndex = normalizedIndex;
            audio.pause();
            audio.removeAttribute('src');
            audio.src = track.src;
            audio.load();
            if (progress) progress.value = '0';
            if (currentTimeElement) currentTimeElement.textContent = '0:00';
            if (durationElement) durationElement.textContent = '0:00';
            updateTrackInterface();
            updatePlayButtons();

            if (shouldPlay) startPlayback();
        }

        function togglePlayback() {
            if (audio.paused) {
                if (!audio.getAttribute('src')) {
                    const currentTrack = getTrack(currentIndex);
                    if (currentTrack) audio.src = currentTrack.src;
                }
                startPlayback();
            } else {
                audio.pause();
            }
        }

        trackButtons.forEach((button, index) => {
            button.addEventListener('click', () => loadTrack(index, true));
        });

        playButton?.addEventListener('click', togglePlayback);
        persistentPlayButton?.addEventListener('click', togglePlayback);

        const goPrevious = () => loadTrack(currentIndex - 1, true);
        const goNext = () => loadTrack(currentIndex + 1, true);
        previousButton?.addEventListener('click', goPrevious);
        persistentPreviousButton?.addEventListener('click', goPrevious);
        nextButton?.addEventListener('click', goNext);
        persistentNextButton?.addEventListener('click', goNext);

        progress?.addEventListener('input', () => {
            isSeeking = true;
            const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
            if (duration > 0) {
                const newTime = (Number(progress.value) / 100) * duration;
                if (currentTimeElement) currentTimeElement.textContent = formatDuration(newTime);
            }
        });

        progress?.addEventListener('change', () => {
            const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
            if (duration > 0) audio.currentTime = (Number(progress.value) / 100) * duration;
            isSeeking = false;
            updateProgress();
        });

        volume?.addEventListener('input', () => {
            audio.volume = Math.min(1, Math.max(0, Number(volume.value)));
        });

        audio.volume = volume ? Math.min(1, Math.max(0, Number(volume.value))) : 0.7;
        audio.addEventListener('timeupdate', updateProgress);
        audio.addEventListener('loadedmetadata', updateProgress);
        audio.addEventListener('durationchange', updateProgress);
        audio.addEventListener('play', updatePlayButtons);
        audio.addEventListener('pause', updatePlayButtons);
        audio.addEventListener('ended', goNext);
        audio.addEventListener('error', () => {
            updatePlayButtons();
            if (artistElement) artistElement.textContent = 'Arquivo não encontrado. Confira o caminho da música.';
        });

        artworkButton?.addEventListener('click', () => {
            if (videoMessageDialog && typeof videoMessageDialog.showModal === 'function') {
                if (!videoMessageDialog.open) videoMessageDialog.showModal();
            } else if (videoMessageDialog) {
                videoMessageDialog.setAttribute('open', '');
            }
        });

        // A faixa 01 fica selecionada, mas não começa automaticamente:
        // navegadores normalmente bloqueiam áudio sem uma ação da pessoa.
        loadTrack(currentIndex, false);
    }

    /* ========================================================================
       6. DIÁLOGOS (MENSAGEM DO VIDEOCLIPE, FOTO AMPLIADA E EXCLUSÃO)
       ======================================================================== */

    function initDialogs() {
        $$('[data-close-dialog]').forEach((button) => {
            button.addEventListener('click', () => {
                const dialog = button.closest('dialog');
                if (dialog && typeof dialog.close === 'function') dialog.close();
                else if (dialog) dialog.removeAttribute('open');
            });
        });

        $$('dialog').forEach((dialog) => {
            dialog.addEventListener('click', (event) => {
                if (event.target === dialog && typeof dialog.close === 'function') {
                    dialog.close();
                }
            });
        });
    }

    /* ========================================================================
       7. ÁLBUM DO SHADOW & DA SKY
       ======================================================================== */

    const albumState = {
        photos: [],
        selectedFiles: [],
        pendingDeleteId: null,
        loading: false,
        apiAvailable: false,
        objectUrls: []
    };

    function showAlbumMessage(message, isError = false) {
        const box = $('#album-upload-message');
        if (!box) return;
        box.textContent = message;
        box.classList.toggle('is-error', Boolean(isError));
        setHidden(box, false);
    }

    function hideAlbumMessage() {
        const box = $('#album-upload-message');
        if (box) setHidden(box, true);
    }

    function clearObjectUrls() {
        albumState.objectUrls.forEach((url) => URL.revokeObjectURL(url));
        albumState.objectUrls = [];
    }

    function normalizePhoto(photo, index) {
        if (!photo || typeof photo !== 'object') return null;
        const id = photo.id ?? photo.photoId ?? photo.photo_id ?? `photo-${index}`;
        const pet = String(photo.pet || photo.animal || '').toLowerCase();
        const urlValue = photo.url || photo.publicUrl || photo.public_url || photo.imageUrl || photo.image_url || photo.signedUrl || photo.signed_url || '';
        const url = safeMediaUrl(urlValue);
        if (!url || !['shadow', 'sky'].includes(pet)) return null;

        return {
            id: String(id),
            pet,
            url,
            caption: String(photo.caption || photo.description || '').slice(0, 250),
            createdAt: photo.createdAt || photo.created_at || photo.uploadedAt || photo.uploaded_at || null
        };
    }

    function extractPhotos(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.photos)) return payload.photos;
        if (payload && Array.isArray(payload.data)) return payload.data;
        return [];
    }

    async function loadAlbumPhotos() {
        const allGrid = $('#album-gallery-all');
        if (!allGrid || albumState.loading) return;
        albumState.loading = true;

        try {
            const response = await fetch(CONFIG.albumEndpoint, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                cache: 'no-store'
            });

            if (!response.ok) {
                throw new Error(`O servidor respondeu com o código ${response.status}.`);
            }

            const payload = await readJsonResponse(response);
            const normalized = extractPhotos(payload)
                .map((photo, index) => normalizePhoto(photo, index))
                .filter(Boolean);

            normalized.sort((a, b) => {
                const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                return dateB - dateA;
            });

            albumState.photos = normalized;
            albumState.apiAvailable = true;
            renderAlbum();
        } catch (error) {
            // Um servidor ainda não configurado não impede o restante do site.
            // A mensagem aparece somente no console; a galeria mantém o estado vazio.
            albumState.apiAvailable = false;
            console.info('O álbum ainda aguarda a API do server.js:', error.message);
            renderAlbum();
        } finally {
            albumState.loading = false;
        }
    }

    function createEmptyState(pet) {
        const wrapper = document.createElement('div');
        wrapper.className = 'album-empty-state';

        const icon = document.createElement('span');
        icon.className = 'album-empty-state__icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = pet === 'shadow' ? '🐈‍⬛' : pet === 'sky' ? '🐈' : '🐾';

        const heading = document.createElement('h4');
        heading.className = 'album-empty-state__title';
        heading.textContent = pet === 'shadow'
            ? 'Ainda não tem fotos do Shadow por aqui.'
            : pet === 'sky'
                ? 'Ainda não tem fotos da Sky por aqui.'
                : 'O álbum está esperando as primeiras fotos.';

        const description = document.createElement('p');
        description.className = 'album-empty-state__text';
        description.textContent = pet === 'shadow'
            ? 'Vamos guardar os momentos dele?'
            : pet === 'sky'
                ? 'O cantinho dela está prontinho para receber lembranças.'
                : 'Adicione uma foto do Shadow ou da Sky para começar esta coleção.';

        const link = document.createElement('a');
        link.className = 'button button--secondary';
        link.href = '#album-upload';
        link.textContent = pet === 'shadow'
            ? 'Adicionar foto do Shadow'
            : pet === 'sky'
                ? 'Adicionar foto da Sky'
                : 'Adicionar primeira foto';

        wrapper.append(icon, heading, description, link);
        return wrapper;
    }

    function createPhotoCard(photo) {
        const article = document.createElement('article');
        article.className = 'album-photo-card';
        article.dataset.photoId = photo.id;

        const imageButton = document.createElement('button');
        imageButton.className = 'album-photo-card__image-button';
        imageButton.type = 'button';
        imageButton.dataset.photoOpen = photo.id;
        imageButton.setAttribute('aria-label', `Ampliar foto do ${photo.pet === 'shadow' ? 'Shadow' : 'Sky'}`);

        const image = document.createElement('img');
        image.className = 'album-photo-card__image';
        image.src = photo.url;
        image.alt = photo.caption
            ? `${photo.pet === 'shadow' ? 'Shadow' : 'Sky'}: ${photo.caption}`
            : `Foto do ${photo.pet === 'shadow' ? 'Shadow' : 'Sky'}`;
        image.loading = 'lazy';
        image.decoding = 'async';
        imageButton.appendChild(image);

        const body = document.createElement('div');
        body.className = 'album-photo-card__body';

        const petLabel = document.createElement('span');
        petLabel.className = 'album-photo-card__pet';
        petLabel.textContent = photo.pet === 'shadow' ? '🐈‍⬛ Shadow' : '🐈 Sky';

        const caption = document.createElement('p');
        caption.className = 'album-photo-card__caption';
        caption.textContent = photo.caption || 'Uma lembrança especial. ♡';

        const date = document.createElement('time');
        date.className = 'album-photo-card__date';
        date.textContent = formatDate(photo.createdAt);
        if (photo.createdAt) {
            const parsed = new Date(photo.createdAt);
            if (!Number.isNaN(parsed.getTime())) date.dateTime = parsed.toISOString();
        }

        body.append(petLabel, caption, date);

        const deleteButton = document.createElement('button');
        deleteButton.className = 'album-photo-card__delete';
        deleteButton.type = 'button';
        deleteButton.dataset.photoDelete = photo.id;
        deleteButton.setAttribute('aria-label', 'Remover esta foto do álbum');
        deleteButton.title = 'Remover foto';
        deleteButton.textContent = '×';

        article.append(imageButton, body, deleteButton);
        return article;
    }

    function renderAlbum() {
        const grids = {
            all: $('#album-gallery-all'),
            shadow: $('#album-gallery-shadow'),
            sky: $('#album-gallery-sky')
        };
        if (!grids.all || !grids.shadow || !grids.sky) return;

        Object.values(grids).forEach((grid) => grid.replaceChildren());

        const counts = { all: albumState.photos.length, shadow: 0, sky: 0 };
        albumState.photos.forEach((photo) => {
            counts[photo.pet] += 1;
            grids.all.appendChild(createPhotoCard(photo));
            grids[photo.pet].appendChild(createPhotoCard(photo));
        });

        if (albumState.photos.length === 0) grids.all.appendChild(createEmptyState('all'));
        if (counts.shadow === 0) grids.shadow.appendChild(createEmptyState('shadow'));
        if (counts.sky === 0) grids.sky.appendChild(createEmptyState('sky'));

        const countAll = $('#album-count-all');
        const countShadow = $('#album-count-shadow');
        const countSky = $('#album-count-sky');
        if (countAll) countAll.textContent = String(counts.all);
        if (countShadow) countShadow.textContent = String(counts.shadow);
        if (countSky) countSky.textContent = String(counts.sky);
    }

    function setAlbumTab(pet) {
        $$('[data-album-filter]').forEach((button) => {
            const active = button.dataset.albumFilter === pet;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });

        $$('[data-album-panel]').forEach((panel) => {
            setHidden(panel, panel.dataset.albumPanel !== pet);
        });
    }

    function renderSelectedFiles() {
        const fileLabel = $('#album-selected-files');
        const previewGrid = $('#album-upload-previews');
        if (!fileLabel || !previewGrid) return;

        clearObjectUrls();
        previewGrid.replaceChildren();

        if (!albumState.selectedFiles.length) {
            fileLabel.textContent = 'Nenhuma foto selecionada.';
            return;
        }

        const totalBytes = albumState.selectedFiles.reduce((sum, file) => sum + file.size, 0);
        const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
        fileLabel.textContent = `${albumState.selectedFiles.length} foto(s) selecionada(s) • ${totalMb} MB no total.`;

        albumState.selectedFiles.forEach((file, index) => {
            const preview = document.createElement('div');
            preview.className = 'album-preview-item';

            if (file.type.startsWith('image/') && !/heic|heif/i.test(file.type + file.name)) {
                const objectUrl = URL.createObjectURL(file);
                albumState.objectUrls.push(objectUrl);
                const image = document.createElement('img');
                image.src = objectUrl;
                image.alt = `Prévia de ${file.name}`;
                image.loading = 'lazy';
                preview.appendChild(image);
            } else {
                const fallback = document.createElement('span');
                fallback.textContent = '🖼️';
                fallback.setAttribute('aria-label', 'Pré-visualização indisponível');
                fallback.style.display = 'grid';
                fallback.style.width = '100%';
                fallback.style.height = '100%';
                fallback.style.placeItems = 'center';
                fallback.style.fontSize = '25px';
                preview.appendChild(fallback);
            }

            const removeButton = document.createElement('button');
            removeButton.className = 'album-preview-item__remove';
            removeButton.type = 'button';
            removeButton.dataset.removeSelectedFile = String(index);
            removeButton.setAttribute('aria-label', `Remover ${file.name} da seleção`);
            removeButton.textContent = '×';
            preview.appendChild(removeButton);
            previewGrid.appendChild(preview);
        });
    }

    function syncFileInput() {
        const input = $('#album-photo-files');
        if (!input || typeof DataTransfer === 'undefined') return;
        const transfer = new DataTransfer();
        albumState.selectedFiles.forEach((file) => transfer.items.add(file));
        input.files = transfer.files;
    }

    function addSelectedFiles(incomingFiles) {
        const allowedMimeTypes = new Set([
            'image/jpeg', 'image/png', 'image/webp', 'image/avif',
            'image/heic', 'image/heif'
        ]);
        const accepted = [];
        const rejected = [];

        Array.from(incomingFiles || []).forEach((file) => {
            const extensionOkay = /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(file.name);
            const mimeOkay = allowedMimeTypes.has(file.type);
            if (!mimeOkay && !extensionOkay) {
                rejected.push(`${file.name}: formato não aceito`);
                return;
            }
            if (file.size > CONFIG.maxImageSizeBytes) {
                rejected.push(`${file.name}: ultrapassa 15 MB`);
                return;
            }
            const alreadyAdded = albumState.selectedFiles.some((existing) =>
                existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified
            );
            if (!alreadyAdded) accepted.push(file);
        });

        albumState.selectedFiles.push(...accepted);
        syncFileInput();
        renderSelectedFiles();

        if (rejected.length) {
            showAlbumMessage(`Alguns arquivos não foram adicionados: ${rejected.slice(0, 4).join('; ')}.`, true);
        } else if (accepted.length) {
            hideAlbumMessage();
        }
    }

    function setUploadProgress(percent, statusText = '') {
        const progressWrap = $('#album-upload-progress');
        const progressBar = $('#album-upload-progress-bar');
        const percentText = $('#album-upload-percent');
        const status = $('#album-upload-status');
        const clamped = Math.min(100, Math.max(0, Math.round(percent)));
        setHidden(progressWrap, false);
        if (progressBar) progressBar.value = clamped;
        if (percentText) percentText.textContent = `${clamped}%`;
        if (status && statusText) status.textContent = statusText;
    }

    function hideUploadProgress() {
        const progressWrap = $('#album-upload-progress');
        setHidden(progressWrap, true);
    }

    function uploadAlbumFiles(formData) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', CONFIG.albumUploadEndpoint, true);
            xhr.withCredentials = true;
            xhr.timeout = CONFIG.uploadTimeoutMs;
            xhr.setRequestHeader('Accept', 'application/json');

            xhr.upload.addEventListener('progress', (event) => {
                if (!event.lengthComputable) return;
                const percent = (event.loaded / event.total) * 100;
                setUploadProgress(percent, 'Enviando fotos para a nuvem...');
            });

            xhr.addEventListener('load', () => {
                let payload = {};
                try {
                    payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
                } catch (error) {
                    payload = { message: 'O servidor retornou uma resposta inválida.' };
                }

                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(payload);
                } else {
                    reject(new Error(getApiErrorMessage(payload, `Falha no envio (código ${xhr.status}).`)));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Não foi possível conectar ao servidor do álbum.')));
            xhr.addEventListener('timeout', () => reject(new Error('O envio demorou mais do que o esperado. Tente novamente com menos fotos.')));
            xhr.addEventListener('abort', () => reject(new Error('O envio foi cancelado.')));
            xhr.send(formData);
        });
    }

    async function handleAlbumUpload(event) {
        event.preventDefault();
        const submitButton = $('#album-upload-submit');
        const fileInput = $('#album-photo-files');
        const petInput = $('input[name="pet"]:checked');
        const captionInput = $('#album-photo-caption');

        if (!albumState.selectedFiles.length) {
            showAlbumMessage('Escolha pelo menos uma foto para adicionar ao álbum. ♡', true);
            fileInput?.focus();
            return;
        }

        const pet = petInput ? petInput.value : 'shadow';
        if (!['shadow', 'sky'].includes(pet)) {
            showAlbumMessage('Escolha se a foto é do Shadow ou da Sky.', true);
            return;
        }

        const formData = new FormData();
        formData.append('pet', pet);
        formData.append('caption', captionInput?.value.trim() || '');
        albumState.selectedFiles.forEach((file) => formData.append('photos', file, file.name));

        if (submitButton) {
            submitButton.disabled = true;
            submitButton.setAttribute('aria-busy', 'true');
        }
        hideAlbumMessage();
        setUploadProgress(0, 'Preparando o envio...');

        try {
            const result = await uploadAlbumFiles(formData);
            setUploadProgress(100, 'Fotos enviadas com sucesso!');
            showAlbumMessage('Prontinho! As fotos foram adicionadas ao álbum. ♡');

            albumState.selectedFiles = [];
            if (fileInput) fileInput.value = '';
            if (captionInput) captionInput.value = '';
            renderSelectedFiles();
            clearObjectUrls();

            await loadAlbumPhotos();
            const selectedTab = pet === 'shadow' ? 'shadow' : 'sky';
            setAlbumTab(selectedTab);

            if (!Array.isArray(result.photos)) {
                // A API pode apenas confirmar a gravação. Nesse caso, a lista
                // GET /api/album é a fonte oficial e já foi recarregada acima.
                console.info('Upload confirmado pelo servidor; galeria atualizada pela consulta.');
            }
        } catch (error) {
            console.error('Erro ao enviar fotos:', error);
            hideUploadProgress();
            showAlbumMessage(
                `${error.message} O álbum só salva as fotos quando o server.js estiver conectado ao Supabase.`,
                true
            );
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
            }
        }
    }

    function openPhotoViewer(photo) {
        const dialog = $('#photo-viewer-dialog');
        const image = $('#photo-viewer-image');
        const title = $('#photo-viewer-title');
        const description = $('#photo-viewer-description');
        if (!dialog || !image) return;

        image.src = photo.url;
        image.alt = photo.caption || `Foto do ${photo.pet === 'shadow' ? 'Shadow' : 'Sky'}`;
        if (title) title.textContent = photo.pet === 'shadow' ? 'Shadow 🐈‍⬛' : 'Sky 🐈';
        if (description) description.textContent = photo.caption || formatDate(photo.createdAt);

        if (typeof dialog.showModal === 'function') {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
    }

    function openDeleteDialog(photoId) {
        const dialog = $('#album-delete-dialog');
        if (!dialog) return;
        albumState.pendingDeleteId = photoId;
        if (typeof dialog.showModal === 'function') {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
    }

    async function deleteAlbumPhoto() {
        const id = albumState.pendingDeleteId;
        if (!id) return;

        const password = window.prompt('Digite a senha de gerenciamento para remover esta foto:');
        if (password === null) return;
        if (!password.trim()) {
            showAlbumMessage('A senha de gerenciamento é necessária para remover uma foto.', true);
            return;
        }

        const confirmButton = $('#confirm-delete-photo');
        if (confirmButton) confirmButton.disabled = true;

        try {
            const response = await fetch(CONFIG.albumDeleteEndpoint(id), {
                method: 'DELETE',
                headers: {
                    'Accept': 'application/json',
                    [CONFIG.albumDeletePasswordHeader]: password
                },
                credentials: 'same-origin'
            });
            const payload = await readJsonResponse(response);
            if (!response.ok) {
                throw new Error(getApiErrorMessage(payload, `Não foi possível remover a foto (código ${response.status}).`));
            }

            const dialog = $('#album-delete-dialog');
            if (dialog && typeof dialog.close === 'function') dialog.close();
            else if (dialog) dialog.removeAttribute('open');

            albumState.pendingDeleteId = null;
            showAlbumMessage('Foto removida do álbum. ♡');
            await loadAlbumPhotos();
        } catch (error) {
            console.error('Erro ao remover foto:', error);
            showAlbumMessage(`${error.message} A exclusão precisa ser autorizada pelo server.js.`, true);
        } finally {
            if (confirmButton) confirmButton.disabled = false;
        }
    }

    function initAlbum() {
        const uploadForm = $('#album-upload-form');
        const fileInput = $('#album-photo-files');
        const dropzone = $('#album-dropzone');
        if (!uploadForm) return;

        $$('[data-album-filter]').forEach((button) => {
            button.addEventListener('click', () => setAlbumTab(button.dataset.albumFilter || 'all'));
        });

        fileInput?.addEventListener('change', () => {
            addSelectedFiles(fileInput.files);
        });

        // Permite arrastar e soltar fotos na área de seleção.
        if (dropzone) {
            ['dragenter', 'dragover'].forEach((eventName) => {
                dropzone.addEventListener(eventName, (event) => {
                    event.preventDefault();
                    dropzone.classList.add('is-dragging');
                });
            });
            ['dragleave', 'drop'].forEach((eventName) => {
                dropzone.addEventListener(eventName, (event) => {
                    event.preventDefault();
                    dropzone.classList.remove('is-dragging');
                });
            });
            dropzone.addEventListener('drop', (event) => {
                if (event.dataTransfer?.files?.length) addSelectedFiles(event.dataTransfer.files);
            });
        }

        $('#album-upload-previews')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove-selected-file]');
            if (!button) return;
            const index = Number(button.dataset.removeSelectedFile);
            if (!Number.isInteger(index)) return;
            albumState.selectedFiles.splice(index, 1);
            syncFileInput();
            renderSelectedFiles();
        });

        uploadForm.addEventListener('submit', handleAlbumUpload);

        Object.values({ all: $('#album-gallery-all'), shadow: $('#album-gallery-shadow'), sky: $('#album-gallery-sky') })
            .filter(Boolean)
            .forEach((grid) => {
                grid.addEventListener('click', (event) => {
                    const openButton = event.target.closest('[data-photo-open]');
                    const deleteButton = event.target.closest('[data-photo-delete]');

                    if (openButton) {
                        const photo = albumState.photos.find((item) => item.id === openButton.dataset.photoOpen);
                        if (photo) openPhotoViewer(photo);
                    }

                    if (deleteButton) {
                        openDeleteDialog(deleteButton.dataset.photoDelete);
                    }
                });
            });

        $('#confirm-delete-photo')?.addEventListener('click', deleteAlbumPhoto);

        $('#album-delete-dialog')?.addEventListener('close', () => {
            albumState.pendingDeleteId = null;
        });

        setAlbumTab('all');
        renderSelectedFiles();
        loadAlbumPhotos();
    }

    /* ========================================================================
       8. INICIALIZAÇÃO
       ======================================================================== */

    function initializeCantinho() {
        initNavigation();
        initMiniAI();
        initPrisonGame();
        initQuotes();
        initMusicPlayer();
        initDialogs();
        initAlbum();

        document.documentElement.classList.add('js-ready');
        console.info('Cantinho da Sarah: interações do front-end inicializadas.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeCantinho, { once: true });
    } else {
        initializeCantinho();
    }
})();
