const mongoose = require('mongoose');
const summaryService = require('./summary.service');
const relationshipService = require('./relationship.service');

/**
 * Fetch or create the Memory record for a given user and companion.
 * Integrates auto-migration from older Conversation schema settings if available.
 */
async function getOrCreateMemory(userId, companionName) {
  const Memory = mongoose.model('Memory');
  const Conversation = mongoose.model('Conversation');

  let memory = await Memory.findOne({ userId, companionName });
  if (!memory) {
    const conversation = await Conversation.findOne({ userId, companionName });
    memory = await Memory.create({
      userId,
      companionName,
      summary: conversation ? conversation.summary : "",
      pinnedMemories: conversation ? conversation.memories : [],
      relationshipLevel: conversation ? (conversation.relationshipLevel || 1.0) : 1.0,
      importantFacts: [],
      lastActiveTime: conversation ? conversation.updatedAt : new Date(),
      conversationCount: conversation && conversation.history.length > 0 ? 1 : 0,
      totalMessages: conversation ? conversation.history.length : 0,
      preferredLanguage: conversation ? conversation.language : "English"
    });
    console.log(`[Memory Service] Migrated/Initialized new Memory record for user ${userId} + companion ${companionName}`);
  }
  return memory;
}

/**
 * Compatibility function to sync memory after conversation updates.
 * Invoked by chatSession.service.js
 */
async function updateMemoryAndSummary(conversationId) {
  const Conversation = mongoose.model('Conversation');
  const Memory = mongoose.model('Memory');

  try {
    const conv = await Conversation.findById(conversationId);
    if (!conv) return;

    const { userId, companionName, history } = conv;
    if (!history || history.length === 0) return;

    // Get or create Memory
    const memory = await getOrCreateMemory(userId, companionName);

    // Update stats
    memory.totalMessages = history.length;
    memory.lastActiveTime = new Date();

    // Increment relationship level slowly
    memory.relationshipLevel = relationshipService.incrementRelationship(memory.relationshipLevel);

    // If conversation history has grown, keep track of count
    if (history.length % 15 === 1) {
      memory.conversationCount += 1;
    }

    await memory.save();

    // Trigger async Together AI summary update with last 15 messages
    const last15 = history.slice(-15);
    summaryService.updateMemoryState(userId, companionName, last15).catch(err => {
      console.error('[Async Memory Update State Error]:', err.message);
    });

    // Keep Conversation model fields in sync to prevent breaking existing systems
    await Conversation.updateOne({ _id: conversationId }, {
      $set: {
        summary: memory.summary,
        memories: memory.pinnedMemories,
        relationshipLevel: memory.relationshipLevel,
        updatedAt: new Date()
      }
    });

  } catch (err) {
    console.error('[Memory Service updateMemoryAndSummary Error]:', err.message);
  }
}

/**
 * Delete memory document for a companion.
 */
async function deleteMemory(userId, companionName) {
  const Memory = mongoose.model('Memory');
  await Memory.deleteOne({ userId, companionName });
}

/**
 * Reset relationship to 1.0.
 */
async function resetRelationship(userId, companionName) {
  const Memory = mongoose.model('Memory');
  const Conversation = mongoose.model('Conversation');

  await Memory.updateOne({ userId, companionName }, { $set: { relationshipLevel: 1.0 } });
  await Conversation.updateOne({ userId, companionName }, { $set: { relationshipLevel: 1.0 } });
}

/**
 * Reset conversation summary.
 */
async function resetSummary(userId, companionName) {
  const Memory = mongoose.model('Memory');
  const Conversation = mongoose.model('Conversation');

  await Memory.updateOne({ userId, companionName }, { $set: { summary: "", currentMood: "" } });
  await Conversation.updateOne({ userId, companionName }, { $set: { summary: "" } });
}

/**
 * Export memory JSON.
 */
async function exportMemory(userId, companionName) {
  const memory = await getOrCreateMemory(userId, companionName);
  return memory.toObject();
}

/**
 * Delete a specific fact or pinned memory.
 */
async function deleteSpecificFact(userId, companionName, type, factText) {
  const Memory = mongoose.model('Memory');
  const Conversation = mongoose.model('Conversation');

  const memory = await getOrCreateMemory(userId, companionName);

  if (type === 'fact') {
    memory.importantFacts = memory.importantFacts.filter(f => f !== factText);
  } else if (type === 'pinned') {
    memory.pinnedMemories = memory.pinnedMemories.filter(m => m !== factText);
  }

  await memory.save();

  // Sync to Conversation model memories
  await Conversation.updateOne({ userId, companionName }, {
    $set: {
      memories: memory.pinnedMemories
    }
  });

  return memory;
}

module.exports = {
  getOrCreateMemory,
  updateMemoryAndSummary,
  deleteMemory,
  resetRelationship,
  resetSummary,
  exportMemory,
  deleteSpecificFact
};
