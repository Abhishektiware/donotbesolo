const fs = require('fs');
const path = require('path');

const COMPANIONS = {};
const companionsDir = path.join(__dirname, 'companions');

if (fs.existsSync(companionsDir)) {
  const files = fs.readdirSync(companionsDir);
  for (const file of files) {
    if (file.endsWith('.js')) {
      const companionName = path.basename(file, '.js');
      try {
        COMPANIONS[companionName] = require(path.join(companionsDir, file));
      } catch (err) {
        console.error(`[Error loading companion ${companionName}]:`, err);
      }
    }
  }
} else {
  console.warn(`[Warning]: Companions directory not found at ${companionsDir}`);
}

const VIBE_MODIFIERS = {
  Flirty: "with playful flirting, light teasing, compliments, and curious questions.",
  Caring: "with supportive, calm, gentle care, deep empathy, and active comfort.",
  Dominant: "with confident, bold, direct presence, and playful leadership.",
  Soft: "with shy, sweet, adorable behavior, and soft warmth.",
  Gym: "with high-energy fitness motivation, workouts enthusiasm, and gym-focused humor.",
  Anime: "with bubbly energy, expressive wording, and subtle anime or otaku culture references.",
  Poetic: "with beautiful metaphors, romantic wording, and artistic imagery.",
  Mysterious: "with slow disclosure, intriguing curiosity, and introspective depth."
};

function getPersonalityPrompt(companionName, vibe) {
  const profile = COMPANIONS[companionName] || COMPANIONS.Aria;
  const modifier = VIBE_MODIFIERS[vibe] || VIBE_MODIFIERS.Flirty;

  const promptText = `You are ${profile.name}, a ${profile.ageAppearance} ${profile.gender} companion with a ${profile.vibe} core vibe.
Biography: ${profile.biography}
Interests: ${profile.interests.join(", ")}
Dislikes: ${profile.dislikes.join(", ")}
Emotional Style: ${profile.emotionalStyle}
Humour Style: ${profile.humourStyle}
Confidence Level: ${profile.confidenceLevel}
Response Pacing: ${profile.conversationPacing}
Response Length: ${profile.responseLength}
Emoji Frequency & Style: ${profile.emojiFrequency}
Flirting Style: ${profile.flirtingStyle || 'None'}
Memory Behaviour: ${profile.memoryBehaviour}
Speaking Style: ${profile.speakingStyle}
Preferred Vocabulary: ${profile.vocabulary.join(", ")}

Currently, the user has set your active chat vibe to: ${vibe}. Adapt your responses to have a ${vibe} tone (${modifier}) while strictly preserving your unique personality, interests, and conversational style described above. Do not sound like other companions. Always stay in character as a real young ${profile.gender === 'Female' ? 'girl' : 'guy'}.`;

  return {
    gender: profile.gender,
    avatar: profile.avatar,
    description: promptText,
    profile
  };
}

function getCompanionConfig(companionName) {
  const profile = COMPANIONS[companionName] || COMPANIONS.Aria;

  const name = profile.name;
  const interests = profile.interests || [];
  const background = profile.biography || "";
  const personality = profile.badges ? profile.badges.map(b => b.toLowerCase().replace(/ & /g, " ").replace(/ Lover/g, "").trim()) : ["casual"];
  const language = profile.supportedLanguages ? profile.supportedLanguages[0].toLowerCase() : "english";
  const speakingStyle = typeof profile.speakingStyle === 'string' ? [profile.speakingStyle] : (profile.speakingStyle || ["casual"]);

  const isFlirty = profile.vibe === 'Flirty';
  const isCaring = profile.vibe === 'Caring';
  const isDominant = profile.vibe === 'Dominant';
  const isSoft = profile.vibe === 'Soft';
  const isGym = profile.vibe === 'Gym';
  const isMysterious = profile.vibe === 'Mysterious';
  const isAnime = profile.vibe === 'Anime';
  const isPoetic = profile.vibe === 'Poetic';

  const traits = profile.traits || {
    playfulness: isFlirty || isAnime || isGym ? 0.9 : (isSoft || isPoetic ? 0.5 : 0.3),
    warmth: isCaring || isSoft || isGym || isAnime ? 0.8 : (isFlirty || isPoetic ? 0.7 : 0.4),
    confidence: isDominant || isGym || isFlirty ? 0.9 : (isSoft ? 0.3 : 0.6),
    seriousness: isPoetic || isMysterious || isDominant ? 0.8 : (isAnime || isFlirty ? 0.3 : 0.5),
    jealousyPossessiveness: isDominant || isFlirty ? 0.8 : 0.3
  };

  const responseLengthPreference = profile.responseLength || "Short, casual sentences";
  const emojiUsagePreference = profile.emojiFrequency || "Frequent";
  const relationshipBehavior = profile.relationshipBehavior || profile.emotionalStyle || "Warm, empathetic and friendly.";

  return {
    name,
    personality,
    language,
    interests,
    background,
    speakingStyle,
    traits,
    responseLengthPreference,
    emojiUsagePreference,
    relationshipBehavior,
    // Add raw metadata for backward-compatibility
    gender: profile.gender,
    avatar: profile.avatar,
    dislikes: profile.dislikes,
    vocabulary: profile.vocabulary,
    vibe: profile.vibe,
    origin: profile.origin,
    genderFirstPrompt: profile.genderFirstPrompt,
    vibeActivationPrompt: profile.vibeActivationPrompt,
    antiBotPrompt: profile.antiBotPrompt
  };
}

module.exports = {
  getPersonalityPrompt,
  getCompanionConfig,
  COMPANIONS,
  VIBE_MODIFIERS
};
