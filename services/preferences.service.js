const mongoose = require('mongoose');

async function loadPreferences(userId, companionName = null) {
  const User = mongoose.model('User');
  const Conversation = mongoose.model('Conversation');
  
  const user = await User.findById(userId);
  if (!user) throw new Error('User profile not found.');

  const activeCompanion = companionName || user.selectedCompanion || 'Aria';

  // Load specific companion settings
  let conversation = await Conversation.findOne({ userId, companionName: activeCompanion });
  if (!conversation) {
    conversation = await Conversation.create({
      userId,
      companionName: activeCompanion,
      vibe: user.selectedVibe || 'Flirty',
      language: user.selectedLanguage || 'English',
      relationshipLevel: 1.0,
      memories: [],
      summary: "",
      history: []
    });
  }

  return {
    userId,
    selectedCompanion: activeCompanion,
    selectedLanguage: conversation.language,
    selectedVibe: conversation.vibe,
    relationshipLevel: conversation.relationshipLevel,
    importantMemories: conversation.memories,
    conversationSummary: conversation.summary,
    updatedAt: conversation.updatedAt
  };
}

async function updatePreferences(userId, data) {
  const User = mongoose.model('User');
  const Conversation = mongoose.model('Conversation');

  const { companion, vibe, language } = data;
  if (!companion || !vibe || !language) {
    throw new Error('Companion, vibe, and language are required.');
  }

  // Save selection permanently in user preferences using updateOne
  await User.updateOne({ _id: userId }, {
    $set: {
      selectedCompanion: companion,
      selectedVibe: vibe,
      selectedLanguage: language,
      activeCompanion: companion,
      activeCompanionName: companion,
      activeVibe: vibe,
      activeLanguage: language
    }
  });

  // Find or create specific companion settings
  let conversation = await Conversation.findOne({ userId, companionName: companion });
  if (!conversation) {
    conversation = await Conversation.create({
      userId,
      companionName: companion,
      vibe,
      language,
      relationshipLevel: 1.0,
      memories: [],
      summary: "",
      history: []
    });
  } else {
    await Conversation.updateOne({ _id: conversation._id }, {
      $set: {
        vibe,
        language,
        updatedAt: new Date()
      }
    });
  }

  return {
    companion,
    vibe,
    language
  };
}

module.exports = {
  loadPreferences,
  updatePreferences
};
