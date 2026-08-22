const mongoose = require('mongoose');

/**
 * Checks if user's subscription is active and checks for expiration.
 * MongoDB is the source of truth.
 * Returns true if active, false if expired or inactive.
 * Updates the database record dynamically if expired.
 * @param {object} user - Mongoose User Document or plain user object
 * @returns {Promise<boolean>}
 */
async function checkSubscription(user) {
  if (!user) return false;

  const Subscription = mongoose.model('Subscription');
  const activeSub = await Subscription.findOne({
    userId: user._id,
    status: 'active',
    endDate: { $gt: new Date() }
  });

  if (activeSub) {
    // Sync User active flag if not already set
    if (!user.isSubscriptionActive) {
      const User = mongoose.model('User');
      await User.updateOne({ _id: user._id }, { $set: { isSubscriptionActive: true, paymentStatus: 'paid' } });
      user.isSubscriptionActive = true;
      user.paymentStatus = 'paid';
    }
    return true;
  }

  // Backward compatibility check: if user has active sub fields in the User document itself
  // but no Subscription document exists, we seed it automatically!
  if (user.subscription && user.subscription.active && user.subscription.expiresAt) {
    if (new Date(user.subscription.expiresAt) > new Date()) {
      // Seed Subscription document
      try {
        await Subscription.create({
          userId: user._id,
          planId: user.subscription.plan || 'Premium Dating Pass',
          transactionId: 'migrated_' + user._id + '_' + Date.now(),
          amount: 110,
          status: 'active',
          startDate: user.subscription.startedAt || new Date(),
          endDate: user.subscription.expiresAt
        });
        return true;
      } catch (err) {
        console.error('[Subscription Auto-Migration Error]:', err);
      }
    }
  }

  // Expiration update on User document if no active subscription document exists
  if (user.isSubscriptionActive) {
    const User = mongoose.model('User');
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          isSubscriptionActive: false,
          'subscription.active': false,
          paymentStatus: 'unpaid'
        }
      }
    );
    user.isSubscriptionActive = false;
    if (user.subscription) user.subscription.active = false;
    user.paymentStatus = 'unpaid';
  }

  return false;
}

module.exports = {
  checkSubscription
};
