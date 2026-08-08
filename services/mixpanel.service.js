const Mixpanel = require('mixpanel');

let mixpanel = null;
const token = process.env.MIXPANEL_TOKEN;

if (token && !token.includes('placeholder') && token.trim() !== '') {
  mixpanel = Mixpanel.init(token);
  console.log(`[Mixpanel Service] Initialized successfully with token: ${token.substring(0, 5)}...`);
} else {
  console.warn('[Mixpanel Service] MIXPANEL_TOKEN is not configured in .env. Falling back to console tracking.');
}

function track(eventName, distinctId, properties = {}) {
  // Log to console for easy visibility
  console.log(`[Mixpanel Track] Event: "${eventName}" | ID: ${distinctId} | Properties:`, JSON.stringify(properties));
  
  if (!mixpanel) return;
  
  try {
    mixpanel.track(eventName, {
      distinct_id: distinctId.toString(),
      ...properties,
      $insert_id: require('crypto').randomBytes(8).toString('hex')
    });
  } catch (err) {
    console.error('[Mixpanel Track Error]:', err.message);
  }
}

function setUserProfile(distinctId, profileData = {}) {
  console.log(`[Mixpanel People Set] ID: ${distinctId} | Profile:`, JSON.stringify(profileData));
  
  if (!mixpanel) return;
  
  try {
    mixpanel.people.set(distinctId.toString(), profileData);
  } catch (err) {
    console.error('[Mixpanel People Set Error]:', err.message);
  }
}

module.exports = {
  track,
  setUserProfile
};
