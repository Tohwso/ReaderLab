// ============ ReaderLab — DemoProvider (simulador local de LLM) ============
// Gera resultados plausíveis e DETERMINÍSTICOS a partir dos atributos da
// persona — sem rede, sem key, sem backend. Serve para demonstrar o fluxo
// completo (execução → validação → persistência) e para testar a UI.
// NÃO é uma LLM: não lê o texto, apenas simula uma resposta coerente com a
// configuração da persona. Nunca use em produção.

import { ProviderError } from "./provider.js";

// PRNG determinístico (mulberry32) — mesma persona + mesmo texto = mesmo resultado
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Encontra o valor de um atributo da persona pelo nome (normalizado)
function attrValue(persona, attributes, name, fallback = 50) {
  const target = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const att = attributes.find((a) =>
    a.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") === target);
  if (!att) return fallback;
  const v = persona.attributeValues ? persona.attributeValues[att.id] : null;
  return v != null ? v : (att.defaultValue != null ? att.defaultValue : fallback);
}

export class DemoProvider {
  constructor({ persona, attributes, reactions, survey }) {
    this.persona = persona;
    this.attributes = attributes;
    this.reactions = reactions;
    this.survey = survey;
  }

  async complete({ userPrompt }) {
    // Simula latência de rede para o botão mostrar o estado "Executando…"
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 800));

    const seed = hashString(this.persona.id + "|" + userPrompt.length + "|" + (this.persona.name || ""));
    const rnd = mulberry32(seed);

    const engagement = clamp(Math.round(
      55 + (attrValue(this.persona, this.attributes, "Orientação a ideias") - 50) * 0.25 +
      (attrValue(this.persona, this.attributes, "Orientação a enredo") - 50) * 0.2 +
      (attrValue(this.persona, this.attributes, "Orientação emocional") - 50) * 0.15 +
      (rnd() - 0.5) * 20), 5, 98);
    const curiosity = clamp(Math.round(engagement + (rnd() - 0.5) * 25), 5, 98);
    const fatigue = clamp(Math.round(100 - engagement + (rnd() - 0.5) * 20), 2, 95);

    // Reações: escolhe 1–3 da taxonomia ativa, intensidade correlacionada ao engajamento
    const chosen = [];
    const pool = [...this.reactions];
    const count = 1 + Math.floor(rnd() * Math.min(3, pool.length));
    for (let i = 0; i < count && pool.length; i++) {
      const idx = Math.floor(rnd() * pool.length);
      const def = pool.splice(idx, 1)[0];
      const base = def.polarity === "positiva" ? engagement : def.polarity === "negativa" ? 100 - engagement : 50;
      const intensity = def.intensityEnabled ? clamp(Math.round(base + (rnd() - 0.5) * 30), 5, 98) : null;
      const reasons = {
        positiva: "Este trecho ressoou com o que eu busco em uma leitura.",
        negativa: "Algo aqui me desconectou da experiência.",
        neutra: "Um momento que me fez pausar e refletir.",
      };
      chosen.push({ reaction_code: def.code, intensity, reason: reasons[def.polarity] || "Reação registrada." });
    }

    // Respostas da pesquisa: escalas seguem o engajamento; textos genéricos plausíveis
    const answers = this.survey.questions.map((q) => {
      if (q.type === "scale") {
        return { question_id: q.id, value: clamp(Math.round(engagement + (rnd() - 0.5) * 30), q.min, q.max) };
      }
      if (q.type === "number") {
        return { question_id: q.id, value: clamp(Math.round((engagement / 100) * (q.max - q.min) + q.min), q.min, q.max) };
      }
      if (q.type === "boolean") {
        return { question_id: q.id, value: engagement > 55 };
      }
      if (q.type === "single_choice") {
        return { question_id: q.id, value: q.options[Math.floor(rnd() * q.options.length)] };
      }
      if (q.type === "multiple_choice") {
        const shuffled = [...q.options].sort(() => rnd() - 0.5);
        return { question_id: q.id, value: shuffled.slice(0, 1 + Math.floor(rnd() * shuffled.length)) };
      }
      const texts = {
        short_text: "O momento da descoberta.",
        long_text: "O trecho que mais me marcou foi aquele em que a tensão entre os personagens ficou explícita. Senti que a cena carregava o peso de tudo que veio antes.",
      };
      return { question_id: q.id, value: texts[q.type] || "—" };
    });

    const notes = [];
    if (engagement > 75) notes.push("Quero ler o próximo capítulo logo.");
    if (engagement < 40) notes.push("Estou começando a perder o interesse.");
    if (attrValue(this.persona, this.attributes, "Tolerância a ambiguidades") > 70 && rnd() > 0.5) {
      notes.push("Gostei de não ter tudo explicado de imediato.");
    }

    const parsed = {
      reactions: chosen,
      survey_answers: answers,
      spontaneous_notes: notes,
      reader_state: {
        engagement, curiosity, fatigue,
        confusions: fatigue > 60 ? ["algumas passagens exigiram reler"] : [],
        predictions: curiosity > 60 ? ["o conflito central vai escalar"] : [],
      },
    };

    return { content: JSON.stringify(parsed), raw: { demo: true } };
  }
}
