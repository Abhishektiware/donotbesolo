const axios = require('axios');
const mongoose = require('mongoose');
const relationshipService = require('./relationship.service');

/**
 * Generate a structured conversation summary and update user+companion memory state.
 * Uses Llama 3.3 70B model via Together AI.
 */
async function updateMemoryState(userId, companionName, lastMessages) {
  const apiKey = (process.env.BLUEMINDS_API_KEY || '').trim();
  if (!apiKey || apiKey.includes('placeholder')) {
    console.warn('[Summary Service] Bluesminds API key is placeholder or missing, skipping summary update.');
    return;
  }

  const Memory = mongoose.model('Memory');
  const User = mongoose.model('User');
  let memory = await Memory.findOne({ userId, companionName });
  if (!memory) {
    console.warn(`[Summary Service] No memory record found for user ${userId} and companion ${companionName}`);
    return;
  }

  const user = await User.findById(userId);
  const userName = user ? (user.fullname || user.username) : 'Abhishek';

  // Format message history
  const formattedHistory = lastMessages
    .map(m => `${m.role === 'user' ? 'User' : companionName}: ${m.content}`)
    .join('\n');

  const relationshipStage = relationshipService.getRelationshipStage(memory.relationshipLevel);

  const prompt = `You are a memory processor for an AI companion application.
Analyze the following recent chat history between User (${userName}) and Companion (${companionName}):
\"\"\"
${formattedHistory}
\"\"\"

Current Memory State:
- Summary: \"${memory.summary || 'None'}\"
- Pinned Memories: ${JSON.stringify(memory.pinnedMemories)}
- Important Facts: ${JSON.stringify(memory.importantFacts)}
- Nickname: \"${memory.nickname || ''}\"
- Current Mood: \"${memory.currentMood || ''}\"
- Relationship Level: ${memory.relationshipLevel.toFixed(1)}/100 (${relationshipStage})

Tasks:
1. Write a concise, 1-2 sentence summary of today's conversation. Focus only on key developments.
2. Extract or update "importantFacts" about the user. Focus ONLY on meaningful long-term details (name, age, birthday, job, country, anime, food, gym goals, hobbies, pets, dreams). Do NOT remember random small talk (weather, simple greetings, one-word messages).
3. Extract or update "pinnedMemories". These must include anything the user explicitly told you to remember (e.g. starting with "remember that...", "this is important...", "I have a...") or key details that should be pinned for context.
4. Extract "nickname" if you gave the user a nickname during this chat.
5. Identify the user's current emotional state/mood ("currentMood") based on the chat.

Output strictly as a JSON object with this exact schema:
{
  "summary": "string",
  "importantFacts": ["string"],
  "pinnedMemories": ["string"],
  "nickname": "string",
  "currentMood": "string"
}
Do not include any markdown wrap, backticks, or explanatory text. Return only the raw JSON.`;

  try {
    const res = await axios.post('https://api.bluesminds.com/v1/chat/completions', {
      model: 'meta/llama-3.1-8b-instruct',
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.2
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const outputText = res.data.choices[0].message.content.trim();
    const cleanJsonText = outputText.replace(/```json|```/g, "").trim();
    let data;
    try {
      data = JSON.parse(cleanJsonText);
    } catch (parseErr) {
      console.error('[Summary Service JSON Parse Error]: Failed to parse generated summary JSON:', parseErr.message);
      return;
    }

    if (data.summary) {
      memory.summary = data.summary;
    }
    if (Array.isArray(data.importantFacts)) {
      // Deduplicate and filter out short/empty strings
      memory.importantFacts = Array.from(new Set([
        ...memory.importantFacts,
        ...data.importantFacts
      ])).filter(f => f && f.trim().length > 2);
    }
    if (Array.isArray(data.pinnedMemories)) {
      // Deduplicate and filter out short/empty strings
      memory.pinnedMemories = Array.from(new Set([
        ...memory.pinnedMemories,
        ...data.pinnedMemories
      ])).filter(m => m && m.trim().length > 2);
    }
    if (data.nickname) {
      memory.nickname = data.nickname;
    }
    if (data.currentMood) {
      memory.currentMood = data.currentMood;
    }

    memory.updatedAt = new Date();
    await memory.save();

    console.log(`[Summary Service] Memory updated successfully for ${companionName} + ${userId}`);
  } catch (err) {
    console.error('[Summary Service Error]:', err.message);
  }
}

module.exports = {
  updateMemoryState
};
