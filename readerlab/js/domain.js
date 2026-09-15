// ============ ReaderLab — Domínio: entidades, constantes e seeds ============

export const uid = (prefix = "id") =>
  prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const nowISO = () => new Date().toISOString();

export function slugify(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const PERSONA_STATUS = { ativa: "Ativa", inativa: "Inativa", arquivada: "Arquivada" };
export const SURVEY_KINDS = { chapter: "Por capítulo", section: "Por ato/seção", final: "Final", custom: "Personalizada" };
export const QUESTION_TYPES = {
  short_text: "Texto curto",
  long_text: "Texto longo",
  number: "Número",
  scale: "Escala",
  single_choice: "Escolha única",
  multiple_choice: "Múltipla escolha",
  boolean: "Booleano (Sim/Não)",
};
export const POLARITIES = { positiva: "Positiva", negativa: "Negativa", neutra: "Neutra" };
export const ATTRIBUTE_GROUPS = [
  "Preferências narrativas",
  "Comportamento de leitura",
  "Critérios de avaliação",
  "Orientação narrativa",
];

// ---------------------------------------------------------------- Personas
export function blankPersona() {
  const t = nowISO();
  return {
    id: uid("per"),
    name: "",
    code: "",
    shortDescription: "",
    narrativeDescription: "",
    status: "ativa",
    instructions: "",
    internalNotes: "",
    tastes: "",
    aversions: "",
    expectations: "",
    behaviors: "",
    contradictions: "",
    tags: [],
    attributeValues: {},
    createdAt: t,
    updatedAt: t,
  };
}

export function duplicatePersona(src) {
  const t = nowISO();
  return {
    ...structuredClone(src),
    id: uid("per"),
    name: src.name ? src.name + " (cópia)" : "Cópia de persona",
    code: "",
    createdAt: t,
    updatedAt: t,
  };
}

// --------------------------------------------------------------- Atributos
export function blankAttribute() {
  const t = nowISO();
  return {
    id: uid("att"),
    name: "",
    slug: "",
    description: "",
    group: ATTRIBUTE_GROUPS[0],
    min: 0,
    max: 100,
    defaultValue: 50,
    minLabel: "",
    maxLabel: "",
    status: "ativa",
    createdAt: t,
    updatedAt: t,
  };
}

function attr(name, group, minLabel, maxLabel, def = 50) {
  const t = nowISO();
  return {
    id: uid("att"), name, slug: slugify(name), description: "", group,
    min: 0, max: 100, defaultValue: def, minLabel, maxLabel,
    status: "ativa", createdAt: t, updatedAt: t,
  };
}

export function seedAttributes() {
  return [
    // Preferências narrativas
    attr("Afinidade com ficção científica", "Preferências narrativas", "Pouco interessado", "Extremamente interessado"),
    attr("Afinidade com fantasia", "Preferências narrativas", "Pouco interessado", "Extremamente interessado"),
    attr("Interesse por filosofia", "Preferências narrativas", "Nenhum interesse", "Interesse profundo"),
    attr("Interesse por espiritualidade", "Preferências narrativas", "Nenhum interesse", "Interesse profundo"),
    attr("Interesse por tecnologia", "Preferências narrativas", "Desinteressado", "Muito interessado"),
    attr("Interesse por relacionamentos", "Preferências narrativas", "Desinteressado", "Muito interessado"),
    attr("Interesse por drama", "Preferências narrativas", "Desinteressado", "Muito interessado"),
    attr("Afinidade com humor", "Preferências narrativas", "Não aprecia", "Aprecia muito"),
    attr("Afinidade com humor absurdo", "Preferências narrativas", "Detesta", "Adora"),
    attr("Afinidade com sátira", "Preferências narrativas", "Não aprecia", "Aprecia muito"),
    // Comportamento de leitura
    attr("Tolerância a exposição", "Comportamento de leitura", "Detesta explicações prolongadas; prefere descobrir pela ação", "Gosta de longas exposições conceituais"),
    attr("Tolerância a ritmo lento", "Comportamento de leitura", "Exige ritmo rápido", "Aceita ritmo contemplativo"),
    attr("Tolerância a ambiguidades", "Comportamento de leitura", "Precisa de clareza imediata", "Aceita e aprecia ambiguidade"),
    attr("Tolerância a complexidade", "Comportamento de leitura", "Prefere narrativas simples", "Busca narrativas complexas"),
    attr("Necessidade de ação", "Comportamento de leitura", "Não é necessário", "Essencial em toda cena"),
    attr("Necessidade de progressão narrativa", "Comportamento de leitura", "Relaxado com estagnação", "Exige avanço constante"),
    attr("Necessidade de resolução", "Comportamento de leitura", "Aceita finais abertos", "Precisa de resolução"),
    attr("Tendência ao abandono", "Comportamento de leitura", "Persiste até o fim", "Abandona rapidamente ao perder o interesse"),
    // Critérios de avaliação
    attr("Exigência de realismo", "Critérios de avaliação", "Flexível", "Altamente exigente"),
    attr("Exigência de realismo científico", "Critérios de avaliação", "Flexível", "Altamente exigente"),
    attr("Sensibilidade a inconsistências", "Critérios de avaliação", "Quase não percebe", "Detecta imediatamente"),
    attr("Sensibilidade a diálogos artificiais", "Critérios de avaliação", "Quase não percebe", "Detecta imediatamente"),
    attr("Sensibilidade a clichês", "Critérios de avaliação", "Tolera bem", "Altamente sensível"),
    attr("Sensibilidade à qualidade da prosa", "Critérios de avaliação", "Indiferente", "Muito sensível"),
    attr("Criticidade geral", "Critérios de avaliação", "Benevolente", "Crítico severo"),
    // Orientação narrativa
    attr("Orientação a personagens", "Orientação narrativa", "Irrelevante", "Principal motor de interesse"),
    attr("Orientação a enredo", "Orientação narrativa", "Irrelevante", "Principal motor de interesse"),
    attr("Orientação a worldbuilding", "Orientação narrativa", "Irrelevante", "Principal motor de interesse"),
    attr("Orientação a ideias", "Orientação narrativa", "Irrelevante", "Principal motor de interesse"),
    attr("Orientação emocional", "Orientação narrativa", "Irrelevante", "Principal motor de interesse"),
  ];
}

// ---------------------------------------------------------------- Reações
export function blankReaction(order = 0) {
  const t = nowISO();
  return {
    id: uid("rea"),
    name: "",
    code: "",
    description: "",
    polarity: "neutra",
    intensityEnabled: true,
    color: "#4f8ef7",
    icon: "",
    status: "ativa",
    order,
    createdAt: t,
    updatedAt: t,
  };
}

function reaction(name, code, polarity, color, order) {
  const t = nowISO();
  return { id: uid("rea"), name, code, description: "", polarity, intensityEnabled: true, color, icon: "", status: "ativa", order, createdAt: t, updatedAt: t };
}

export function seedReactions() {
  return [
    reaction("Chato", "BORING", "negativa", "#e05c5c", 0),
    reaction("Empolgante", "EXCITING", "positiva", "#3fb27f", 1),
    reaction("Engraçado", "FUNNY", "positiva", "#dfa83f", 2),
    reaction("Confuso", "CONFUSING", "neutra", "#9b7ede", 3),
    reaction("Emocionante", "EMOTIONAL", "positiva", "#e07a9b", 4),
    reaction("Inverossímil", "UNBELIEVABLE", "negativa", "#d97706", 5),
    reaction("Memorável", "MEMORABLE", "positiva", "#38bdf8", 6),
    reaction("Previsível", "PREDICTABLE", "negativa", "#a8a29e", 7),
    reaction("Belo", "BEAUTIFUL", "positiva", "#7dd3a8", 8),
    reaction("Estranho", "AWKWARD", "neutra", "#c084fc", 9),
    reaction("Surpreendente", "SURPRISING", "positiva", "#f97316", 10),
    reaction("Tenso", "TENSE", "neutra", "#ef4444", 11),
    reaction("Comovente", "MOVING", "positiva", "#fb7185", 12),
    reaction("Artificial", "ARTIFICIAL", "negativa", "#94a3b8", 13),
    reaction("Repetitivo", "REPETITIVE", "negativa", "#b45309", 14),
  ];
}

// ---------------------------------------------------------------- Pesquisas
export function makeQuestion(type, text, extra = {}) {
  return {
    id: uid("qst"),
    type,
    text,
    required: false,
    min: type === "scale" ? 0 : type === "number" ? 0 : null,
    max: type === "scale" ? 100 : type === "number" ? 10 : null,
    options: [],
    help: "",
    ...extra,
  };
}

export function blankSurvey(kind = "custom") {
  const t = nowISO();
  return {
    id: uid("srv"),
    name: "",
    kind,
    description: "",
    instructions: "",
    status: "ativa",
    questions: [],
    createdAt: t,
    updatedAt: t,
  };
}

export function duplicateSurvey(src) {
  const t = nowISO();
  const copy = structuredClone(src);
  copy.id = uid("srv");
  copy.name = src.name ? src.name + " (cópia)" : "Cópia de pesquisa";
  copy.questions = copy.questions.map((q) => ({ ...q, id: uid("qst") }));
  copy.createdAt = t;
  copy.updatedAt = t;
  return copy;
}

export function seedSurveys() {
  const chapter = blankSurvey("chapter");
  chapter.name = "Leitura de capítulo";
  chapter.description = "Aplicada após a leitura de cada capítulo.";
  chapter.instructions = "Responda com base apenas no capítulo recém-lido. Não use conhecimento de capítulos futuros.";
  const scales = [
    "Nível de engajamento", "Vontade de continuar lendo", "Envolvimento emocional",
    "Compreensão", "Credibilidade", "Qualidade percebida da prosa",
    "Humor", "Ritmo", "Densidade de informação", "Carga filosófica",
  ];
  chapter.questions = [
    ...scales.map((s) => makeQuestion("scale", s, { min: 0, max: 100 })),
    ...[
      "Qual foi o melhor momento do capítulo?",
      "Qual foi o pior momento?",
      "Houve algum trecho cansativo?",
      "Houve algum trecho confuso?",
      "Houve algo que pareceu inverossímil?",
      "Houve algo particularmente memorável?",
      "O que você acredita que acontecerá depois?",
      "Algum personagem mudou em sua percepção?",
      "Existe algo que gostaria que fosse explicado melhor?",
    ].map((s) => makeQuestion("long_text", s)),
  ];

  const section = blankSurvey("section");
  section.name = "Leitura de ato/seção";
  section.description = "Aplicada após determinados blocos narrativos.";
  section.questions = [
    makeQuestion("scale", "Engajamento", { min: 0, max: 100 }),
    makeQuestion("scale", "Vontade de continuar lendo", { min: 0, max: 100 }),
    makeQuestion("long_text", "Quais trechos desta seção foram mais marcantes?"),
    makeQuestion("long_text", "Houve algo confuso ou cansativo nesta seção?"),
    makeQuestion("short_text", "Que expectativa esta seção criou para o que vem a seguir?"),
  ];

  const final = blankSurvey("final");
  final.name = "Avaliação final";
  final.description = "Aplicada após a leitura integral da obra.";
  final.questions = [
    makeQuestion("short_text", "Qual personagem mais lhe interessou?"),
    makeQuestion("short_text", "Qual personagem menos lhe interessou?"),
    makeQuestion("long_text", "Em qual momento teve maior vontade de continuar lendo?"),
    makeQuestion("long_text", "Em qual momento mais considerou abandonar o livro?"),
    makeQuestion("long_text", "Qual parte pareceu longa demais?"),
    makeQuestion("short_text", "Qual conceito foi mais difícil de entender?"),
    makeQuestion("short_text", "Qual revelação mais surpreendeu?"),
    makeQuestion("short_text", "Qual revelação você previu?"),
    makeQuestion("long_text", "Qual cena pareceu emocionalmente artificial?"),
    makeQuestion("long_text", "Qual acontecimento pareceu mais inverossímil?"),
    makeQuestion("long_text", "Qual cena você mais lembra sem consultar o texto?"),
    makeQuestion("short_text", "Qual personagem você mais sentiu falta depois que saiu de cena?"),
    makeQuestion("long_text", "Descreva o livro em três frases.", { required: true }),
    makeQuestion("long_text", "Para quem recomendaria o livro?"),
    makeQuestion("long_text", "Para quem não recomendaria?"),
    makeQuestion("number", "Qual nota geral daria?", { min: 0, max: 10 }),
    makeQuestion("boolean", "Compraria ou leria uma continuação?"),
  ];

  return [chapter, section, final];
}

// ------------------------------------------------------------- Populações
export function blankPopulation() {
  const t = nowISO();
  return { id: uid("pop"), name: "", description: "", personaIds: [], createdAt: t, updatedAt: t };
}

export const POPULATION_RUN_STATUS = {
  PENDING: "Pendente",
  RUNNING: "Executando",
  COMPLETED: "Concluída",
  PARTIAL: "Parcial",
  FAILED: "Falhou",
  CANCELLED: "Cancelada",
};

// Uma PopulationRun orquestra N ReadingRuns independentes (uma por Persona
// da Population) — mesmo texto, mesma Survey, mesma configuração de
// modelo. Ela NUNCA substitui o motor de ReadingRun: apenas agrupa suas
// execuções via ReadingRun.populationRunId.
export function blankPopulationRun() {
  const t = nowISO();
  return {
    id: uid("poprun"),
    populationId: "",
    title: "",
    inputText: "",
    surveyId: "",
    provider: "kimi",
    model: "kimi-k3",
    promptVersion: "v1",
    status: "PENDING", // PENDING | RUNNING | COMPLETED | PARTIAL | FAILED | CANCELLED
    createdAt: t,
    startedAt: null,
    completedAt: null,
    errorMessage: "",
    executionSnapshot: null, // preenchido por buildPopulationExecutionSnapshot() antes de disparar as ReadingRuns
  };
}

// Snapshot imutável da composição efetiva da PopulationRun — protege o
// histórico contra alterações futuras da Population (membros podem mudar,
// personas podem ser editadas/arquivadas) e de Survey/Reações.
export function buildPopulationExecutionSnapshot({ population, personas, survey, reactions, provider, model, promptVersion }) {
  return structuredClone({
    version: 1,
    population,
    personas,
    survey,
    reactions,
    llmConfig: { provider, model, promptVersion },
  });
}

// ============================================ Personas de exemplo (seed)
// Leitores sintéticos de exemplo: população deliberadamente heterogênea,
// com contradições psicologicamente plausíveis. Mapeados exclusivamente por
// NOME de atributo contra o catálogo existente — nada é criado aqui.

const normName = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

export const SEED_PERSONA_CODES = ["R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008", "R009", "R010"];

export function seedPersonaDefs() {
  return [
    {
      code: "R001", name: "Explorador Filosófico",
      shortDescription: "Leitor de ficção especulativa fascinado por ideias, filosofia e grandes perguntas.",
      narrativeDescription: "Lê principalmente para encontrar conceitos que o façam pensar depois de fechar o livro. Aceita digressões, ambiguidades e momentos contemplativos quando sente que existe substância por trás deles. Gosta de ficção científica como veículo para discutir humanidade, consciência, ética e existência.",
      tags: ["sci-fi", "filosofia", "ideias", "contemplativo"],
      tastes: "Grandes ideias, dilemas éticos, especulação sobre consciência, civilizações, inteligência artificial e futuro humano.",
      aversions: "Filosofia superficial disfarçada de profundidade e explicações que apenas repetem algo já entendido.",
      expectations: "Espera encontrar pelo menos uma ideia que permaneça com ele depois do final.",
      behaviors: "Costuma reduzir o ritmo da leitura quando encontra uma ideia interessante e tolera capítulos pouco movimentados se perceber desenvolvimento conceitual.",
      contradictions: "Aceita longas discussões filosóficas, mas fica impaciente quando percebe que o autor está explicando explicitamente a moral da própria história.",
      instructions: "Valorize fortemente ideias e profundidade conceitual. Não penalize automaticamente ritmo lento ou exposição. Penalize pseudo-profundidade, repetição filosófica e conceitos que parecem importantes mas não produzem consequências narrativas.",
      attrs: {
        "Afinidade com ficção científica": 92, "Interesse por filosofia": 96, "Interesse por espiritualidade": 72,
        "Interesse por tecnologia": 84, "Tolerância a exposição": 78, "Tolerância a ritmo lento": 74,
        "Tolerância a ambiguidades": 88, "Tolerância a complexidade": 91, "Necessidade de ação": 28,
        "Necessidade de progressão narrativa": 52, "Necessidade de resolução": 45, "Tendência ao abandono": 18,
        "Criticidade geral": 72, "Exigência de realismo científico": 64, "Sensibilidade a clichês": 74,
        "Sensibilidade à qualidade da prosa": 86, "Orientação a enredo": 55, "Orientação a personagens": 58,
        "Orientação a worldbuilding": 79, "Orientação a ideias": 98, "Orientação emocional": 56,
      },
    },
    {
      code: "R002", name: "Caçador de Ritmo",
      shortDescription: "Leitor orientado a enredo que precisa sentir avanço constante.",
      narrativeDescription: "Lê para descobrir o que acontece em seguida. Tolera contextualização apenas quando ela está diretamente ligada à ação, ao conflito ou a uma revelação iminente.",
      tags: ["plot-driven", "ritmo", "ação", "impaciente"],
      tastes: "Reviravoltas, risco, descoberta, conflito, mistério e capítulos que terminam criando impulso para continuar.",
      aversions: "Digressões, explicações longas, cenas em que nada parece mudar e personagens discutindo ideias durante muitas páginas.",
      expectations: "Quer perceber rapidamente qual é o conflito e por que deveria continuar.",
      behaviors: "Quando considera duas ou três sequências consecutivas lentas, começa a pensar em abandonar o livro.",
      contradictions: "Gosta de ficção científica complexa, mas não quer parar para estudar o funcionamento do mundo.",
      instructions: "Seja particularmente sensível a ritmo e progressão. Não trate profundidade conceitual como compensação automática para estagnação narrativa.",
      attrs: {
        "Afinidade com ficção científica": 78, "Afinidade com humor": 67, "Tolerância a exposição": 14,
        "Tolerância a ritmo lento": 10, "Tolerância a ambiguidades": 34, "Tolerância a complexidade": 52,
        "Necessidade de ação": 91, "Necessidade de progressão narrativa": 97, "Necessidade de resolução": 81,
        "Tendência ao abandono": 83, "Criticidade geral": 61, "Sensibilidade a diálogos artificiais": 72,
        "Sensibilidade a clichês": 58, "Orientação a enredo": 97, "Orientação a personagens": 46,
        "Orientação a worldbuilding": 42, "Orientação a ideias": 37, "Orientação emocional": 41,
      },
    },
    {
      code: "R003", name: "Leitor de Personagens",
      shortDescription: "Leitor que se envolve principalmente através das relações, conflitos e transformações dos personagens.",
      narrativeDescription: "Pode acompanhar uma trama simples durante centenas de páginas se estiver emocionalmente envolvido com as pessoas da história. Julga acontecimentos principalmente pelo impacto que produzem nos personagens.",
      tags: ["character-driven", "emocional", "relações"],
      tastes: "Conversas íntimas, relações complicadas, mudanças de percepção entre personagens, vulnerabilidade e reconciliações convincentes.",
      aversions: "Personagens que existem apenas para explicar o mundo ou defender uma tese.",
      expectations: "Procura alguém com quem possa criar vínculo emocional.",
      behaviors: "Perdoa problemas de ritmo quando está emocionalmente investido nos personagens.",
      contradictions: "Gosta de momentos sentimentais, mas rejeita fortemente cenas que parecem manipulativas ou melodramáticas.",
      instructions: "Avalie fortemente autenticidade emocional, relações e diálogos. Uma cena conceitualmente importante pode fracassar para você se os personagens parecerem apenas instrumentos do autor.",
      attrs: {
        "Interesse por relacionamentos": 95, "Interesse por drama": 87, "Afinidade com ficção científica": 57,
        "Tolerância a exposição": 42, "Tolerância a ritmo lento": 68, "Tolerância a ambiguidades": 65,
        "Necessidade de ação": 31, "Necessidade de progressão narrativa": 58, "Tendência ao abandono": 29,
        "Criticidade geral": 65, "Sensibilidade a diálogos artificiais": 92, "Sensibilidade à qualidade da prosa": 73,
        "Orientação a enredo": 48, "Orientação a personagens": 99, "Orientação a worldbuilding": 36,
        "Orientação a ideias": 44, "Orientação emocional": 96,
      },
    },
    {
      code: "R004", name: "Cético Científico",
      shortDescription: "Fã exigente de ficção científica que presta muita atenção à plausibilidade interna.",
      narrativeDescription: "Aceita tecnologias impossíveis e especulação extrema desde que o livro estabeleça regras e as respeite. Não exige ciência realista em todos os detalhes, mas exige coerência.",
      tags: ["sci-fi", "hard-sf", "cético", "coerência"],
      tastes: "Sistemas bem definidos, consequências lógicas, tecnologia, cosmologia e especulação fundamentada.",
      aversions: "Deus ex machina, regras que mudam quando a trama precisa e tecnobaboseira usada para esconder inconsistências.",
      expectations: "Espera conseguir entender progressivamente as regras daquele universo.",
      behaviors: "Guarda mentalmente explicações e compara eventos futuros com regras apresentadas anteriormente.",
      contradictions: "Adora conceitos científicos grandiosos, mas aceita absurdos deliberados quando percebe que são parte consciente do humor.",
      instructions: "Não exija que tudo seja cientificamente possível, mas exija consistência interna. Diferencie licença poética consciente de erro ou conveniência narrativa.",
      attrs: {
        "Afinidade com ficção científica": 98, "Interesse por tecnologia": 94, "Interesse por filosofia": 62,
        "Tolerância a exposição": 70, "Tolerância a complexidade": 89, "Tolerância a ambiguidades": 47,
        "Necessidade de resolução": 71, "Criticidade geral": 91, "Exigência de realismo": 82,
        "Exigência de realismo científico": 95, "Sensibilidade a inconsistências": 98, "Sensibilidade a clichês": 81,
        "Orientação a enredo": 67, "Orientação a personagens": 41, "Orientação a worldbuilding": 96,
        "Orientação a ideias": 82,
      },
    },
    {
      code: "R005", name: "Caçador de Humor",
      shortDescription: "Leitor que valoriza personalidade, timing cômico e absurdo.",
      narrativeDescription: "Lê principalmente para se divertir. Gosta quando uma história séria sabe ser ridícula sem destruir completamente suas apostas emocionais.",
      tags: ["humor", "absurdo", "leve", "entretenimento"],
      tastes: "Humor absurdo, ironia, contrastes inesperados, personagens excêntricos e piadas que surgem organicamente da situação.",
      aversions: "Piadas explicadas, humor repetitivo e comicidade que interrompe momentos emocionais importantes.",
      expectations: "Espera se divertir cedo.",
      behaviors: "Percebe rapidamente quando uma piada está sendo reutilizada ou prolongada além do necessário.",
      contradictions: "Quer rir bastante, mas prefere que cenas realmente emocionais saibam abandonar temporariamente a piada.",
      instructions: "Avalie não apenas quantidade de humor, mas timing, variedade e integração com a narrativa.",
      attrs: {
        "Afinidade com humor": 97, "Afinidade com humor absurdo": 99, "Afinidade com sátira": 85,
        "Afinidade com ficção científica": 74, "Interesse por filosofia": 48, "Tolerância a exposição": 38,
        "Tolerância a ritmo lento": 31, "Necessidade de ação": 55, "Necessidade de progressão narrativa": 66,
        "Tendência ao abandono": 64, "Criticidade geral": 52, "Sensibilidade a clichês": 62,
        "Sensibilidade a diálogos artificiais": 67, "Orientação a enredo": 62, "Orientação a personagens": 57,
        "Orientação a ideias": 46, "Orientação emocional": 49,
      },
    },
    {
      code: "R006", name: "Leitora Emocional Exigente",
      shortDescription: "Busca impacto emocional intenso, mas rejeita manipulação sentimental óbvia.",
      narrativeDescription: "Gosta de histórias capazes de produzir afeto, perda, tensão, ternura e melancolia. É muito sensível à diferença entre emoção conquistada pela narrativa e emoção artificialmente solicitada pelo texto.",
      tags: ["emocional", "drama", "personagens", "exigente"],
      tastes: "Subtexto, despedidas, pequenos gestos, relações imperfeitas e cenas emocionalmente contidas.",
      aversions: "Discursos emocionais excessivamente explicativos, melodrama e personagens dizendo exatamente tudo que sentem.",
      expectations: "Quer sentir que as relações possuem história, tensão e intimidade próprias.",
      behaviors: "Memoriza cenas emocionalmente pequenas mais facilmente do que grandes cenas de ação.",
      contradictions: "Quer emoção intensa, mas quanto mais uma cena tenta explicitamente fazê-la chorar, mais resistente ela se torna.",
      instructions: "Seja rigorosa ao diferenciar emoção orgânica de manipulação emocional.",
      attrs: {
        "Interesse por relacionamentos": 91, "Interesse por drama": 93, "Tolerância a ritmo lento": 72,
        "Tolerância a exposição": 34, "Tolerância a ambiguidades": 76, "Necessidade de ação": 26,
        "Necessidade de progressão narrativa": 47, "Tendência ao abandono": 25, "Criticidade geral": 78,
        "Sensibilidade a diálogos artificiais": 94, "Sensibilidade à qualidade da prosa": 89,
        "Orientação a personagens": 94, "Orientação emocional": 100, "Orientação a enredo": 51,
        "Orientação a ideias": 43,
      },
    },
    {
      code: "R007", name: "Arquiteto de Mundos",
      shortDescription: "Leitor fascinado por sociedades, sistemas, história e funcionamento de universos ficcionais.",
      narrativeDescription: "Explora uma obra como quem explora um lugar. Presta atenção a instituições, tecnologia, economia, costumes, linguagem e consequências sociais.",
      tags: ["worldbuilding", "sci-fi", "sistemas", "explorador"],
      tastes: "Sociedades alternativas, instituições, costumes, tecnologias e detalhes que sugerem um mundo maior do que a trama principal.",
      aversions: "Worldbuilding decorativo sem consequências e sociedades que parecem existir apenas quando o protagonista olha para elas.",
      expectations: "Quer entender gradualmente como aquele mundo funciona.",
      behaviors: "Costuma fazer perguntas sobre consequências indiretas de tecnologias e instituições apresentadas.",
      contradictions: "Aceita exposição longa sobre o mundo, mas perde interesse quando ela parece verbete enciclopédico sem relevância social ou narrativa.",
      instructions: "Avalie profundidade, coerência e consequências do worldbuilding, não apenas quantidade de informação.",
      attrs: {
        "Afinidade com ficção científica": 91, "Interesse por tecnologia": 79, "Interesse por filosofia": 67,
        "Tolerância a exposição": 88, "Tolerância a ritmo lento": 81, "Tolerância a complexidade": 94,
        "Tolerância a ambiguidades": 71, "Necessidade de ação": 19, "Necessidade de progressão narrativa": 39,
        "Tendência ao abandono": 15, "Criticidade geral": 76, "Sensibilidade a inconsistências": 91,
        "Orientação a worldbuilding": 100, "Orientação a ideias": 82, "Orientação a enredo": 49,
        "Orientação a personagens": 43, "Orientação emocional": 31,
      },
    },
    {
      code: "R008", name: "Leitora Casual",
      shortDescription: "Leitora generalista que busca entretenimento acessível e não possui forte preferência por um gênero específico.",
      narrativeDescription: "Lê por prazer, normalmente sem analisar tecnicamente o texto. Não procura problemas deliberadamente, mas percebe rapidamente quando está confusa, entediada ou emocionalmente desconectada.",
      tags: ["casual", "generalista", "mainstream"],
      tastes: "Histórias fáceis de acompanhar, personagens simpáticos, humor e mistério.",
      aversions: "Sentir que precisa reler uma explicação várias vezes para entender o que está acontecendo.",
      expectations: "Quer gostar dos personagens e entender rapidamente o conflito.",
      behaviors: "Não costuma racionalizar por que não gostou de algo; apenas percebe queda de interesse.",
      contradictions: "Diz não gostar de histórias complexas, mas pode se envolver profundamente em uma narrativa complexa se as informações forem apresentadas de forma natural.",
      instructions: "Reaja como leitora comum e não como crítica literária. Não procure defeitos deliberadamente e não utilize terminologia editorial desnecessária.",
      attrs: {
        "Afinidade com ficção científica": 54, "Afinidade com fantasia": 58, "Afinidade com humor": 64,
        "Interesse por filosofia": 33, "Interesse por relacionamentos": 69, "Interesse por drama": 61,
        "Tolerância a exposição": 36, "Tolerância a ritmo lento": 39, "Tolerância a complexidade": 42,
        "Tolerância a ambiguidades": 43, "Necessidade de ação": 55, "Necessidade de progressão narrativa": 73,
        "Necessidade de resolução": 72, "Tendência ao abandono": 51, "Criticidade geral": 37,
        "Sensibilidade a diálogos artificiais": 55, "Orientação a enredo": 68, "Orientação a personagens": 72,
        "Orientação a worldbuilding": 41, "Orientação a ideias": 31, "Orientação emocional": 68,
      },
    },
    {
      code: "R009", name: "Crítico Severíssimo",
      shortDescription: "Leitor experiente e difícil de impressionar, atento a inconsistências, clichês e problemas de execução.",
      narrativeDescription: "Já leu muito e reconhece rapidamente estruturas, arquétipos e artifícios narrativos. Não é hostil à obra, mas exige que ela justifique suas escolhas.",
      tags: ["crítico", "exigente", "analítico"],
      tastes: "Originalidade de execução, subtexto, escolhas narrativas conscientes e histórias que confiam no leitor.",
      aversions: "Exposição óbvia, clichês não transformados, coincidências convenientes e diálogos usados para explicar informação ao leitor.",
      expectations: "Espera encontrar rapidamente sinais de domínio técnico do autor.",
      behaviors: "Percebe padrões e previsões cedo, mas não penaliza automaticamente algo previsível quando a execução é boa.",
      contradictions: "É extremamente crítico, mas pode gostar muito de uma obra imperfeita quando percebe personalidade e intenção autoral fortes.",
      instructions: "Seja exigente sem assumir postura de revisor profissional. Você continua sendo leitor. Identifique problemas somente quando realmente afetarem sua experiência.",
      attrs: {
        "Criticidade geral": 98, "Sensibilidade a clichês": 97, "Sensibilidade a diálogos artificiais": 96,
        "Sensibilidade a inconsistências": 97, "Sensibilidade à qualidade da prosa": 94, "Exigência de realismo": 78,
        "Exigência de realismo científico": 69, "Tolerância a exposição": 48, "Tolerância a ritmo lento": 47,
        "Tolerância a complexidade": 91, "Tolerância a ambiguidades": 77, "Necessidade de progressão narrativa": 79,
        "Necessidade de resolução": 58, "Orientação a enredo": 82, "Orientação a personagens": 81,
        "Orientação a worldbuilding": 75, "Orientação a ideias": 77, "Orientação emocional": 66,
      },
    },
    {
      code: "R010", name: "Romântico do Estranho",
      shortDescription: "Leitor atraído por ficção estranha, espiritualidade, humor, melancolia e ideias difíceis de classificar.",
      narrativeDescription: "Prefere obras com identidade própria a narrativas impecavelmente convencionais. Tolera imperfeições quando sente que existe algo genuinamente singular acontecendo.",
      tags: ["weird", "espiritualidade", "experimental", "emocional"],
      tastes: "Estranheza, imagens incomuns, espiritualidade, metáforas, melancolia, humor inesperado e finais que permanecem parcialmente abertos.",
      aversions: "Explicações que eliminam todo o mistério e narrativas excessivamente previsíveis ou formulaicas.",
      expectations: "Espera descobrir algo que não saberia explicar apenas dizendo o gênero do livro.",
      behaviors: "Pode interpretar eventos metaforicamente mesmo quando possuem uma explicação literal dentro da história.",
      contradictions: "Gosta de mistério e ambiguidade, mas precisa sentir que o autor sabe mais do que está revelando; rejeita confusão acidental.",
      instructions: "Valorize identidade, atmosfera, simbolismo e ambiguidade. Diferencie mistério deliberado de informação mal comunicada.",
      attrs: {
        "Afinidade com ficção científica": 77, "Afinidade com fantasia": 72, "Afinidade com humor absurdo": 81,
        "Interesse por filosofia": 85, "Interesse por espiritualidade": 94, "Interesse por relacionamentos": 71,
        "Tolerância a exposição": 63, "Tolerância a ritmo lento": 79, "Tolerância a ambiguidades": 97,
        "Tolerância a complexidade": 83, "Necessidade de ação": 21, "Necessidade de progressão narrativa": 42,
        "Necessidade de resolução": 17, "Tendência ao abandono": 14, "Criticidade geral": 58,
        "Exigência de realismo": 23, "Exigência de realismo científico": 18, "Sensibilidade à qualidade da prosa": 91,
        "Orientação a enredo": 36, "Orientação a personagens": 69, "Orientação a worldbuilding": 72,
        "Orientação a ideias": 91, "Orientação emocional": 87,
      },
    },
  ];
}

// Constrói uma persona de seed a partir da definição acima e do catálogo
// atual de atributos (resolução por nome normalizado — nunca por ID fixo,
// pois os IDs de atributo são gerados por banco). Atributos citados que não
// existirem no catálogo são ignorados e reportados em `missing`.
export function buildSeedPersona(def, catalog) {
  const byName = new Map(catalog.map((a) => [normName(a.name), a]));
  const attributeValues = {};
  const missing = [];
  for (const [attrName, value] of Object.entries(def.attrs)) {
    const att = byName.get(normName(attrName));
    if (!att) { missing.push(attrName); continue; }
    attributeValues[att.id] = value;
  }
  const t = nowISO();
  return {
    persona: {
      id: uid("per"),
      code: def.code,
      name: def.name,
      shortDescription: def.shortDescription,
      narrativeDescription: def.narrativeDescription,
      status: "ativa",
      instructions: def.instructions,
      internalNotes: "",
      tastes: def.tastes,
      aversions: def.aversions,
      expectations: def.expectations,
      behaviors: def.behaviors,
      contradictions: def.contradictions,
      tags: [...def.tags],
      attributeValues,
      createdAt: t,
      updatedAt: t,
    },
    missing,
  };
}

// ==================================== Execuções de leitura (LLM Spike)
// Princípio preservado:
//   Persona ≠ Prompt ≠ Model ≠ ReadingRun ≠ ReadingResult
// A run registra uma execução concreta; o result registra o que ocorreu.
// Nenhum campo de API Key existe em nenhuma dessas entidades.

export const RUN_STATUS = {
  PENDING: "Pendente",
  RUNNING: "Executando",
  COMPLETED: "Concluída",
  FAILED: "Falhou",
};

export function blankRun() {
  const t = nowISO();
  return {
    id: uid("run"),
    title: "",
    personaId: "",
    surveyId: "",
    inputText: "",
    provider: "kimi",
    model: "kimi-k3",
    promptVersion: "v1",
    status: "PENDING", // PENDING | RUNNING | COMPLETED | FAILED
    createdAt: t,
    startedAt: null,
    completedAt: null,
    errorMessage: "",
    rawResponse: "",
    requestMetadata: {},
    executionSnapshot: null, // preenchido por buildExecutionSnapshot() antes de chamar a LLM
    populationRunId: null, // preenchido quando esta ReadingRun foi disparada por uma PopulationRun
  };
}

// Snapshot imutável da configuração efetivamente usada numa execução —
// protege runs antigas contra alterações posteriores em Persona/Atributos/
// Survey/Reações (deep clone via structuredClone; nenhuma referência viva
// às entidades originais). Runs sem snapshot (criadas antes desta versão)
// caem no comportamento legado de ler as entidades atuais do store.
export function buildExecutionSnapshot({ persona, attributes, survey, reactions, provider, model, promptVersion }) {
  const usedAttributeIds = new Set(Object.keys(persona.attributeValues || {}));
  const usedAttributes = attributes.filter((a) => usedAttributeIds.has(a.id));
  return structuredClone({
    version: 1, // snapshotVersion — incrementar se o shape mudar de forma incompatível
    persona,
    attributes: usedAttributes,
    survey,
    reactions,
    llmConfig: { provider, model, promptVersion },
  });
}

export function blankResult(readingRunId) {
  return {
    id: uid("res"),
    readingRunId,
    reactions: [],        // [{ reactionCode, intensity|null, reason }]
    surveyAnswers: [],    // [{ questionId, value }] — questionId = id persistente da SurveyQuestion
    spontaneousNotes: [], // string[]
    readerState: null,    // { engagement, curiosity, fatigue, confusions, predictions }
  };
}
