const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const memoryService = require('./memory.service');
const relationshipService = require('./relationship.service');
const personalityService = require('./personality.service');

// Middleware to authenticate token (defined globally in server.js but standard implementation here)
// Wait: server.js exports authenticateToken, or we can just expect it to be passed when mounting the routes.
// We will mount router using: app.use('/api/memory', authenticateToken, memoryRoutes);
// So req.user.userId will always be populated.

/**
 * GET /api/memory/active-conversations
 * Fetch all active/previous conversations for the returning user (Continue Conversations)
 */
router.get('/active-conversations', async (req, res) => {
  const userId = req.user.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const Memory = mongoose.model('Memory');
    const memories = await Memory.find({ userId }).sort({ lastActiveTime: -1 });

    const activeConversations = memories.map(mem => {
      const companionMeta = personalityService.COMPANIONS[mem.companionName] || {
        avatar: '👩‍🦰',
        vibe: 'Flirty',
        gender: 'Female'
      };
      return {
        companionName: mem.companionName,
        avatar: companionMeta.avatar,
        vibe: companionMeta.vibe,
        gender: companionMeta.gender || 'Female',
        language: mem.preferredLanguage || 'English',
        lastChat: mem.lastActiveTime,
        relationshipLevel: mem.relationshipLevel,
        relationshipStage: relationshipService.getRelationshipStage(mem.relationshipLevel),
        totalMessages: mem.totalMessages,
        conversationCount: mem.conversationCount,
        summary: mem.summary,
        nickname: mem.nickname,
        currentMood: mem.currentMood
      };
    });

    res.status(200).json(activeConversations);
  } catch (err) {
    console.error('[API active-conversations error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memory/:companionName
 * View memories for the specific companion
 */
router.get('/:companionName', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    const memory = await memoryService.getOrCreateMemory(userId, companionName);
    const relationshipStage = relationshipService.getRelationshipStage(memory.relationshipLevel);

    res.status(200).json({
      success: true,
      memory: {
        companionName: memory.companionName,
        summary: memory.summary,
        pinnedMemories: memory.pinnedMemories,
        relationshipLevel: memory.relationshipLevel,
        relationshipStage,
        importantFacts: memory.importantFacts,
        lastActiveTime: memory.lastActiveTime,
        conversationCount: memory.conversationCount,
        totalMessages: memory.totalMessages,
        preferredLanguage: memory.preferredLanguage,
        currentMood: memory.currentMood,
        nickname: memory.nickname
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/memory/:companionName
 * Delete memory document for the companion
 */
router.delete('/:companionName', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    await memoryService.deleteMemory(userId, companionName);
    res.status(200).json({ success: true, message: `Memory deleted for companion ${companionName}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/:companionName/reset-relationship
 * Reset relationship score to 1.0
 */
router.post('/:companionName/reset-relationship', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    await memoryService.resetRelationship(userId, companionName);
    res.status(200).json({ success: true, message: 'Relationship level reset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/:companionName/reset-summary
 * Reset conversation summary
 */
router.post('/:companionName/reset-summary', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    await memoryService.resetSummary(userId, companionName);
    res.status(200).json({ success: true, message: 'Summary reset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memory/:companionName/export
 * Export companion memories as JSON download
 */
router.get('/:companionName/export', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    const memory = await memoryService.exportMemory(userId, companionName);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${companionName}_memories.json`);
    res.status(200).send(JSON.stringify(memory, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/:companionName/fact/delete
 * Delete a specific fact or pinned memory string
 */
router.post('/:companionName/fact/delete', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;
  const { type, factText } = req.body;

  if (!type || !factText) {
    return res.status(400).json({ error: 'Type and factText are required.' });
  }

  try {
    const updatedMemory = await memoryService.deleteSpecificFact(userId, companionName, type, factText);
    res.status(200).json({ success: true, memory: updatedMemory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/:companionName/new-chat
 * Clear conversation history but keep long-term memories/relationship/pinned facts
 */
router.post('/:companionName/new-chat', async (req, res) => {
  const userId = req.user.userId;
  const { companionName } = req.params;

  try {
    const Conversation = mongoose.model('Conversation');
    const conversation = await Conversation.findOne({ userId, companionName });

    if (conversation) {
      conversation.history = [];
      conversation.summary = "";
      await conversation.save();
    }

    // Keep Memory document intact, but we can set its conversation summary to empty and lastActiveTime to now
    await memoryService.resetSummary(userId, companionName);

    res.status(200).json({ success: true, message: 'Chat history cleared. Stored memories, relationship, and pins were kept.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
