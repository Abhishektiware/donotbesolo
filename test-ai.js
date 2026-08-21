require('dotenv').config();
const axios = require('axios');

async function checkModelsAndTest() {
    const apiKey = (process.env.BLUEMINDS_API_KEY || '').trim();

    try {
        console.log('🔍 Checking available models for your API Key...');
        const modelListRes = await axios.get('https://api.bluesminds.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        const models = modelListRes.data.data || modelListRes.data;
        console.log('📋 Available Model IDs on your account:');
        console.log(models.map(m => m.id || m));

        const selectedModel = models[0]?.id || models[0] || 'llama-3.1-8b-instruct';
        console.log(`\n🚀 Testing chat completion with model: "${selectedModel}"...`);

        const chatRes = await axios.post('https://api.bluesminds.com/v1/chat/completions', {
            model: selectedModel,
            messages: [
                { role: 'system', content: 'You are a warm companion.' },
                { role: 'user', content: 'Hey, are you working?' }
            ],
            max_tokens: 50,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('\n✅ SUCCESS! AI IS WORKING 🚀');
        console.log('🤖 AI Response:', chatRes.data.choices[0].message.content.trim());
    } catch (err) {
        console.error('❌ Error:', err.response ? err.response.data : err.message);
    }
}

checkModelsAndTest();