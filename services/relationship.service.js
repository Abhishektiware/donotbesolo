/**
 * Relationship Service
 * Handles relationship level progression and status categorization
 */

function getRelationshipStage(level) {
  if (level >= 100) return "Soulmate";
  if (level >= 60) return "Trusted Companion";
  if (level >= 30) return "Best Friend";
  if (level >= 15) return "Close Friend";
  if (level >= 5) return "Friendly";
  return "New Stranger";
}

/**
 * Increment the relationship level slowly.
 * Improves naturally over conversations, capping at 100.
 */
function incrementRelationship(currentLevel) {
  const level = currentLevel !== undefined ? currentLevel : 1.0;
  // Slowly increase by a small decimal (e.g. 0.05 per exchange)
  return Math.min(100.0, level + 0.05);
}

module.exports = {
  getRelationshipStage,
  incrementRelationship
};
