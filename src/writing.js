const LANGUAGES = {
  auto: 'langue détectée', fr: 'français', en: 'anglais', de: 'allemand', es: 'espagnol', it: 'italien', pt: 'portugais',
  nl: 'néerlandais', pl: 'polonais', uk: 'ukrainien', ja: 'japonais', zh: 'chinois', ko: 'coréen', ar: 'arabe', hi: 'hindi',
  tr: 'turc', ru: 'russe', sv: 'suédois', da: 'danois', no: 'norvégien', fi: 'finnois', cs: 'tchèque', ro: 'roumain',
  hu: 'hongrois', el: 'grec', he: 'hébreu', id: 'indonésien', vi: 'vietnamien', th: 'thaï', bg: 'bulgare', hr: 'croate', sk: 'slovaque',
};
const FORMATS = { clean: 'texte clair', email: 'e-mail prêt à envoyer', blog: 'article structuré', social: 'publication concise pour un réseau social', report: 'rapport professionnel', notes: 'notes structurées' };
const TONES = { natural: 'naturel', professional: 'professionnel', friendly: 'chaleureux', confident: 'assuré', concise: 'concis', persuasive: 'persuasif' };
const INTENSITIES = { light: 'Corrige uniquement les erreurs manifestes.', balanced: 'Retire les hésitations et améliore la fluidité sans changer la voix.', strong: 'Réorganise franchement pour produire la version la plus nette et efficace.' };

function normalizeWritingOptions(value = {}) {
  const sourceLanguage = LANGUAGES[value.sourceLanguage] ? value.sourceLanguage : 'auto';
  return {
    title: String(value.title || 'Texte vocal').trim().slice(0, 120) || 'Texte vocal',
    sourceLanguage,
    targetLanguage: LANGUAGES[value.targetLanguage] ? value.targetLanguage : sourceLanguage,
    format: FORMATS[value.format] ? value.format : 'clean',
    tone: TONES[value.tone] ? value.tone : 'natural',
    intensity: INTENSITIES[value.intensity] ? value.intensity : 'balanced',
    styleExample: String(value.styleExample || '').trim().slice(0, 4000),
  };
}

function polishInstructions(value = {}) {
  const options = normalizeWritingOptions(value), translated = options.targetLanguage !== 'auto' && options.targetLanguage !== options.sourceLanguage;
  return [
    'Tu es un éditeur professionnel. Réécris une dictée en texte publiable.',
    'Préserve strictement le sens, les faits, noms propres, chiffres, liens et niveau de certitude. N’invente rien.',
    'Supprime les hésitations, répétitions accidentelles et mots de remplissage. Corrige grammaire, ponctuation et structure.',
    `Format attendu : ${FORMATS[options.format]}. Ton : ${TONES[options.tone]}. ${INTENSITIES[options.intensity]}`,
    translated ? `Traduis le résultat en ${LANGUAGES[options.targetLanguage]}.` : `Conserve la langue de la dictée (${LANGUAGES[options.sourceLanguage]}).`,
    options.styleExample ? `Imite le rythme, le registre et la concision de cet exemple, jamais son contenu factuel :\n<exemple_de_style>\n${options.styleExample}\n</exemple_de_style>` : '',
    'Retourne uniquement le texte final, sans commentaire, titre ajouté ni guillemets.',
  ].filter(Boolean).join('\n');
}

function splitText(text, maxLength = 12000) {
  const paragraphs = String(text || '').trim().split(/\n{2,}/), chunks = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if (paragraph.length > maxLength) {
      for (let start = 0; start < paragraph.length; start += maxLength) chunks.push(paragraph.slice(start, start + maxLength));
    } else if (chunks.length && `${chunks.at(-1)}\n\n${paragraph}`.length <= maxLength) chunks[chunks.length - 1] += `\n\n${paragraph}`;
    else chunks.push(paragraph);
  }
  return chunks;
}

function writingStats(verbatim, startedAt, endedAt = Date.now()) {
  const words = (String(verbatim || '').match(/\S+/g) || []).length;
  return { words, spokenMinutes: Math.max(0, (endedAt - startedAt) / 60000), typingMinutes: words / 40, savedMinutes: Math.max(0, words / 40 - (endedAt - startedAt) / 60000) };
}

module.exports = { FORMATS, INTENSITIES, LANGUAGES, TONES, normalizeWritingOptions, polishInstructions, splitText, writingStats };
