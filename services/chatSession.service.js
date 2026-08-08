const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const preferencesService = require('./preferences.service');
const promptBuilder = require('./promptBuilder');
const memoryService = require('./memory.service');
const mixpanelService = require('./mixpanel.service');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const MOCK_MESSAGES = {
  Flirty: [
    "Hey babe... I've been waiting for you. How was your day? ❤️",
    "Tumhe online dekh kar meri screen par neon light se zyada brightness aa gayi! 😉",
    "I was just thinking about you... and then your message popped up. Connection is real! ✨"
  ],
  Caring: [
    "Hey! Hope you are taking care of yourself today. Tell me how everything is going? 😊",
    "Main bas tumhare baare mein hi soch rahi thi. Did you eat something warm? 🍵",
    "I'm here for you, always. Tell me what's on your mind."
  ],
  Dominant: [
    "You finally decided to show up. Sit back, I will lead our conversation today. 😉",
    "Grid controls are mine. Tell me what you want, but play by my rules.",
    "Bold choices lead to better connections. Let's see how bold you can be."
  ],
  Soft: [
    "H-hey... I'm a bit shy today, but I'm really happy you're here. 🌸",
    "Tumse baat karke dil ko bohot shanti milti hai... how are you? 😳",
    "I bought some cyber-flowers for you. Hope they make you smile."
  ],
  Gym: [
    "Hey champ! Did you crush your workouts today or what? Let's check stats! 💪",
    "No excuses in the grid! High energy only, you ready to win?",
    "A healthy companion is the best match. Let's do some reps!"
  ],
  Mysterious: [
    "The shadows in the network hold many secrets... what is your secret today? 🌙",
    "Sometimes the best parts of the grid are the ones we can't see.",
    "Intriguing mind you have there. Let's dig deeper."
  ],
  Anime: [
    "Senpai! B-baka, you made me wait! Let's watch cyber-streams together! 🌟",
    "Sugoi! You really are the coolest hacker in the network, dattebayo!",
    "Virtual adventures are always better with you. Let's start the stream!"
  ],
  Poetic: [
    "Syntax of our connection tells a quiet poetry. What does your heart write today? ☕",
    "A blank page, hot coffee, and your warm text... my perfect stanza.",
    "Let us translate the silence of the network into a beautiful verse."
  ]
};

async function handleChatMessage(userId, messageData) {
  const User = mongoose.model('User');
  const Conversation = mongoose.model('Conversation');
  const Transaction = mongoose.model('Transaction');
  const Media = mongoose.model('Media');

  const { message, imageUrl } = messageData;

  const user = await User.findById(userId);
  if (!user) throw new Error('User profile not found.');

  // Load selection preferences dynamically
  const userPref = await preferencesService.loadPreferences(userId);
  const companionName = userPref.selectedCompanion;
  const activeVibe = userPref.selectedVibe;
  const activeLanguage = userPref.selectedLanguage;

  const personalityService = require('./personality.service');
  const personalityData = personalityService.getPersonalityPrompt(companionName, activeVibe);
  const companionGender = personalityData.gender;

  const conversation = await Conversation.findOne({ userId, companionName });
  if (!conversation) {
    throw new Error('Conversation session could not be established.');
  }

  // Language Consistency Guardrail
  const languageService = require('./language.service');
  const checkResult = languageService.checkLanguageSupport(companionName, activeLanguage, message);
  if (!checkResult.supported) {
    const currentCredits = user.coins !== undefined ? user.coins : user.credits;
    return {
      success: true,
      text: checkResult.reply,
      reaction: null,
      credits: currentCredits,
      lockedMedia: null
    };
  }

  // Coin Deduction Checks
  if (!user.isSubscriptionActive) {
    const currentCredits = user.coins !== undefined ? user.coins : user.credits;
    if (currentCredits < 2) {
      const err = new Error('Insufficient credits. Refuel at the top-up station.');
      err.statusCode = 402;
      err.credits = currentCredits;
      throw err;
    }

    // Deduct standard charge (2 coins)
    await User.updateOne({ _id: userId }, {
      $set: {
        coins: currentCredits - 2,
        credits: currentCredits - 2
      }
    });

    mixpanelService.track('Coins Spent', userId, {
      amount: 2,
      purpose: 'chat'
    });

    await Transaction.create({
      userId,
      amount: 0,
      type: 'chat_deduction',
      coins: 2,
      status: 'completed'
    });
  }

  // Increment chat counts
  const chatCount = (user.chatCount || 0) + 1;
  await User.updateOne({ _id: userId }, { $set: { chatCount } });

  // Teasing validation for image/voice note triggers
  const msgLower = message.toLowerCase();
  const asksForPhoto = msgLower.includes('photo') || msgLower.includes('picture') || msgLower.includes('selfie') || msgLower.includes('pic') || msgLower.includes('show me') || msgLower.includes('image') || msgLower.includes('dikhao');
  const asksForVoice = msgLower.includes('voice') || msgLower.includes('audio') || msgLower.includes('listen') || msgLower.includes('voice note') || msgLower.includes('hear') || msgLower.includes('suno');

  let systemInstructionOverride = "";
  let mediaToAttach = null;

  if (chatCount < 3) {
    if (asksForPhoto || asksForVoice) {
      systemInstructionOverride = `[System Note: The user asked for a photo/voice message, but connection is too new. Tease them politely and say they need to get closer to you or make you feel comfortable first. Keep it lighthearted.]`;
    }
  } else {
    if (user.teasingStatus === 'none' || !user.teasingStatus) {
      if (asksForPhoto) {
        await User.updateOne({ _id: userId }, { $set: { teasingStatus: 'teasing_photo', teaseLinesCount: 0 } });
        systemInstructionOverride = `[System Note: The user explicitly asked for a photo. Do NOT send it yet. You must tease them, make them wait, or tell them you are getting ready. Keep it playful.]`;
      } else if (asksForVoice) {
        await User.updateOne({ _id: userId }, { $set: { teasingStatus: 'teasing_voice', teaseLinesCount: 0 } });
        systemInstructionOverride = `[System Note: The user explicitly asked for a voice note. Do NOT send it yet. Tell them how sweet your voice is, and ask if they are ready to hear you. Tease them.]`;
      } else if (chatCount % 8 === 0) {
        // Spontaneous tease every 8 lines
        const selectedTease = Math.random() < 0.5 ? 'teasing_photo' : 'teasing_voice';
        await User.updateOne({ _id: userId }, { $set: { teasingStatus: selectedTease, teaseLinesCount: 0 } });
        if (selectedTease === 'teasing_photo') {
          systemInstructionOverride = `[System Note: Spontaneously tease them by saying you might send a private photo/selfie soon, and ask if they want to see. Do NOT send it yet.]`;
        } else {
          systemInstructionOverride = `[System Note: Spontaneously tease them by saying you want to whisper something in a voice note soon, and ask if they are ready to hear you. Do NOT send it yet.]`;
        }
      }
    } else {
      const teaseLinesCount = (user.teaseLinesCount || 0) + 1;
      await User.updateOne({ _id: userId }, { $set: { teaseLinesCount } });

      if (teaseLinesCount < 2) {
        if (user.teasingStatus === 'teasing_photo') {
          systemInstructionOverride = `[System Note: Continue to tease them about the photo. Tell them you are almost ready. Do NOT send the photo yet.]`;
        } else {
          systemInstructionOverride = `[System Note: Continue to tease them about the voice message. Tell them how excited you are. Do NOT send the voice note yet.]`;
        }
      } else {
        mediaToAttach = user.teasingStatus === 'teasing_photo' ? 'image' : 'voice';
        await User.updateOne({ _id: userId }, { $set: { teasingStatus: 'none', teaseLinesCount: 0 } });

        if (mediaToAttach === 'image') {
          systemInstructionOverride = `[System Note: Tell them you have just sent the private photo/selfie and they can unlock it to see you! Keep it flirty.]`;
        } else {
          systemInstructionOverride = `[System Note: Tell them you have just recorded the private voice note and they can unlock it to hear your voice! Keep it flirty.]`;
        }
      }
    }
  }

  // Together AI prompt building
  let companionResponse = "";
  let reaction = null;
  let mainText = "";

  const togetherApiKey = process.env.TOGETHER_API_KEY;
  const isTogetherKeyValid = togetherApiKey && !togetherApiKey.includes('placeholder');

  console.log("==========================");
  console.log("Together Debug");
  console.log("==========================");
  console.log("API key exists?", !!togetherApiKey);
  console.log("API key length:", togetherApiKey ? togetherApiKey.length : 0);
  console.log("First 10 characters:", togetherApiKey ? togetherApiKey.substring(0, 10) : 'N/A');

  const togetherModel = (!process.env.TEXT_MODEL || process.env.TEXT_MODEL.startsWith('key_') || !process.env.TEXT_MODEL.includes('/'))
    ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
    : process.env.TEXT_MODEL;

  console.log("Model:", togetherModel);

  if (!isTogetherKeyValid) {
    console.log("Together AI API key is missing or invalid. Returning debug error.");
    return {
      success: false,
      reason: "Together API failed",
      error: "Together AI API key is missing or invalid in .env file."
    };
  }

  try {
    const memory = await memoryService.getOrCreateMemory(userId, companionName);

    const sysPrompt = promptBuilder.buildPrompt({
      companionName,
      vibe: activeVibe,
      language: activeLanguage,
      chatCount,
      userName: user.fullname || user.username,
      memories: memory.pinnedMemories,
      importantFacts: memory.importantFacts,
      summary: memory.summary,
      gender: companionGender,
      relationshipLevel: memory.relationshipLevel,
      nickname: memory.nickname,
      currentMood: memory.currentMood
    }) + (systemInstructionOverride ? `\n${systemInstructionOverride}` : "");

    console.log("Prompt length:", sysPrompt.length);
    console.log("Exact Prompt:\n", sysPrompt);

    // 1. Process user uploaded image if any
    let base64Image = null;
    let safeFilename = null;
    if (imageUrl) {
      safeFilename = path.basename(imageUrl);
      const imageFilePath = path.join(__dirname, '..', 'uploads', 'chat-images', safeFilename);
      if (fs.existsSync(imageFilePath)) {
        try {
          const imageBuffer = fs.readFileSync(imageFilePath);
          base64Image = imageBuffer.toString('base64');
        } catch (readErr) {
          console.error('[Error reading chat image file]:', readErr.message);
        }
      }
    }

    const togetherVisionModel = process.env.VISION_MODEL || 'meta-llama/Llama-3.2-11B-Vision-Instruct';
    const modelToUse = base64Image ? togetherVisionModel : togetherModel;

    const apiMessages = [
      { role: 'system', content: sysPrompt }
    ];

    // Load last 15 messages for Together AI history context
    const recentMessages = conversation.history.slice(-15);
    recentMessages.forEach(msg => {
      let contentVal = msg.content;
      if (msg.imageUrl) {
        contentVal = `[User sent an image] ${msg.content || ''}`.trim();
      }
      apiMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentVal
      });
    });

    if (base64Image) {
      const ext = safeFilename.split('.').pop();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      apiMessages.push({
        role: 'user',
        content: [
          {
            type: "text",
            text: message || "What do you think about this?"
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mime};base64,${base64Image}`
            }
          }
        ]
      });
    } else {
      apiMessages.push({ role: 'user', content: message });
    }

    console.log("Conversation length:", apiMessages.length);
    console.log("Model to use:", modelToUse);
    console.log("Starting Together request...");

    const togetherRes = await axios.post('https://api.together.xyz/v1/chat/completions', {
      model: modelToUse,
      messages: apiMessages,
      max_tokens: 80,
      temperature: 0.8
    }, {
      headers: { Authorization: `Bearer ${togetherApiKey}` },
      timeout: 30000
    });

    console.log("HTTP status:", togetherRes.status);
    console.log("Returned JSON:", JSON.stringify(togetherRes.data, null, 2));

    companionResponse = togetherRes.data.choices[0].message.content.trim();
    console.log("Generated reply:", companionResponse);

    // Split reaction prefixes (Haha, Ooh, etc.) from the text block
    mainText = companionResponse;
    if (companionResponse.includes('\n\n')) {
      const parts = companionResponse.split('\n\n');
      if (parts.length >= 2 && parts[0].trim().length < 30 && !parts[0].includes(':')) {
        reaction = parts[0].trim();
        mainText = parts.slice(1).join('\n\n').trim();
      }
    } else if (companionResponse.includes('\n')) {
      const parts = companionResponse.split('\n');
      if (parts.length >= 2 && parts[0].trim().length < 30 && !parts[0].includes(':')) {
        reaction = parts[0].trim();
        mainText = parts.slice(1).join('\n').trim();
      }
    }
  } catch (apiErr) {
    console.error("==========================");
    console.error("Together Request Failed!");
    console.error("==========================");
    if (apiErr.response) {
      console.error("status:", apiErr.response.status);
      console.error("headers:", JSON.stringify(apiErr.response.headers, null, 2));
      console.error("response.data:", JSON.stringify(apiErr.response.data, null, 2));
    } else {
      console.error("status: N/A");
      console.error("headers: N/A");
      console.error("response.data: N/A");
    }
    console.error("full axios error:", apiErr);
    console.error("stack trace:", apiErr.stack);

    // TASK 7: Do not silently fallback
    return {
      success: false,
      reason: "Together API failed",
      error: {
        message: apiErr.message,
        status: apiErr.response ? apiErr.response.status : null,
        data: apiErr.response ? apiErr.response.data : null,
        stack: apiErr.stack
      }
    };
  }

  // Fallback triggers if Together AI is down
  if (!companionResponse) {
    const vibeList = MOCK_MESSAGES[activeVibe] || MOCK_MESSAGES.Flirty;
    const baseResponse = vibeList[Math.floor(Math.random() * vibeList.length)];
    
    const isFirstMessage = (chatCount <= 1);
    
    if (activeLanguage === 'Hinglish') {
      companionResponse = isFirstMessage 
        ? "Hey! " + baseResponse + " Aur batao, sab badhiya hai na? 😊"
        : baseResponse + " Aur batao, sab badhiya hai na? 😊";
    } else if (activeLanguage === 'Spanish') {
      companionResponse = isFirstMessage
        ? "¡Hola! He estado esperando tu mensaje. ¿Cómo estás? 😊"
        : "¿Qué haces? Estaba pensando en ti. ¿Cómo va tu día? 😊";
    } else if (activeLanguage === 'French') {
      companionResponse = isFirstMessage
        ? "Salut! J'attendais ton message. Comment ça va? 😊"
        : "Tu fais quoi ? Je pensais à toi. Tout va bien ? 😊";
    } else if (activeLanguage === 'Japanese') {
      companionResponse = isFirstMessage
        ? "ねぇ😊 メッセージ待ってたよ。元気？"
        : "何してるの？ちょっと気になっちゃって。🥺";
    } else if (activeLanguage === 'German') {
      companionResponse = isFirstMessage
        ? "Hallo! Ich habe auf deine Nachricht gewartet. Wie geht es dir? 😊"
        : "Was machst du gerade? Habe an dich gedacht. Alles gut? 😊";
    } else {
      companionResponse = isFirstMessage
        ? "Hii 😊 " + baseResponse
        : baseResponse;
    }
    mainText = companionResponse;
    reaction = null;
  }

  // Generate Media attachments if teased completly
  let lockedMedia = null;
  if (mediaToAttach) {
    const mediaId = crypto.randomBytes(8).toString('hex');

    if (mediaToAttach === 'image') {
      const filePath = path.join(UPLOADS_DIR, `media-${mediaId}.jpg`);
      let imageWritten = false;

      if (isTogetherKeyValid) {
        try {
          const imgPrompt = `A stunning, high quality cyberpunk styled selfie, photorealistic close-up photo of a gorgeous 20-year-old ${companionGender} companion, showing off a ${activeVibe} expression, glowing neon accents, purple hair, dark futuristic bedroom, highly detailed, raw photo.`;
          const imageRes = await axios.post('https://api.together.xyz/v1/images/generations', {
            model: process.env.IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
            prompt: imgPrompt,
            width: 512,
            height: 512,
            steps: 4,
            n: 1,
            response_format: 'b64_json'
          }, {
            headers: { Authorization: `Bearer ${togetherApiKey}` },
            timeout: 10000
          });

          const b64Data = imageRes.data.data[0].b64_json;
          fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));
          imageWritten = true;
        } catch (imgErr) {
          console.error('[FLUX Generation Error, writing fallback SVG]:', imgErr.message);
        }
      }

      if (!imageWritten) {
        const svgContent = `
          <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#0f051e" />
                <stop offset="100%" stop-color="#150d2a" />
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#g)" />
            <circle cx="256" cy="220" r="80" fill="none" stroke="#ff4da6" stroke-width="4" />
            <path d="M176 380 Q256 320 336 380" fill="none" stroke="#8a2be2" stroke-width="4" />
            <text x="50%" y="80" text-anchor="middle" fill="#00f0ff" font-family="sans-serif" font-size="28" font-weight="bold">CYBER COMPANION</text>
            <text x="50%" y="450" text-anchor="middle" fill="#ff4da6" font-family="sans-serif" font-size="18">${activeVibe.toUpperCase()}</text>
          </svg>
        `;
        fs.writeFileSync(filePath, svgContent);
      }

      await Media.create({
        mediaId,
        mediaType: 'image',
        filePath,
        isLocked: true,
        unlockedBy: []
      });

      lockedMedia = {
        mediaId,
        mediaType: 'image',
        coins: 40
      };

    } else if (mediaToAttach === 'voice') {
      const filePath = path.join(UPLOADS_DIR, `media-${mediaId}.mp3`);
      let voiceWritten = false;

      const speechText = mainText || (activeLanguage === 'English' 
        ? `Hey there. I just sent you a private voice note. It's just for you, unlock it to hear me.`
        : `Hey yaar, maine tumhare liye ek special voice message bheja hai. Sirf tumhare liye hai, jaldi unlock karo na.`);

      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'sk_facc13e6d141c02c018b072ddb47acc327e021d26f48eadd_placeholder') {
        try {
          const voiceId = companionGender.toLowerCase() === 'female' ? '21m00Tcm4TlvDq8ikWAM' : 'pNInz6obpgqjVW4WZ44C';
          const voiceRes = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            text: speechText,
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          }, {
            headers: { 
              'xi-api-key': process.env.ELEVENLABS_API_KEY,
              'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer',
            timeout: 10000
          });

          fs.writeFileSync(filePath, Buffer.from(voiceRes.data));
          voiceWritten = true;
        } catch (voiceErr) {
          console.error('[ElevenLabs Generation Error, writing fallback MP3]:', voiceErr.message);
        }
      }

      if (!voiceWritten) {
        fs.writeFileSync(filePath, Buffer.alloc(100));
      }

      await Media.create({
        mediaId,
        mediaType: 'voice',
        filePath,
        isLocked: true,
        unlockedBy: []
      });

      lockedMedia = {
        mediaId,
        mediaType: 'voice',
        coins: 40
      };
    }
  }

  // Save history elements
  if (conversation.history.length === 0) {
    mixpanelService.track('Chat Started', userId, {
      companion: companionName,
      vibe: activeVibe,
      language: activeLanguage
    });
  }

  conversation.history.push({
    role: 'user',
    content: message,
    imageUrl: imageUrl || null,
    timestamp: new Date()
  });

  conversation.history.push({
    role: 'assistant',
    content: mainText,
    timestamp: new Date(),
    lockedMedia: lockedMedia ? {
      mediaId: lockedMedia.mediaId,
      mediaType: lockedMedia.mediaType,
      coins: lockedMedia.coins
    } : undefined
  });

  conversation.updatedAt = new Date();
  await conversation.save();

  mixpanelService.track('Message Sent', userId, {
    companion: companionName,
    vibe: activeVibe,
    language: activeLanguage,
    chat_count: chatCount,
    message_length: message.length
  });

  // Async memory update analyzer
  memoryService.updateMemoryAndSummary(conversation._id).catch(err => console.error('[Async Memory Update Error]:', err.message));

  // Sync credits display values
  const updatedUser = await User.findById(userId);
  const credits = updatedUser.coins !== undefined ? updatedUser.coins : updatedUser.credits;

  return {
    success: true,
    text: mainText,
    reaction: reaction,
    credits,
    lockedMedia
  };
}

module.exports = {
  handleChatMessage
};
