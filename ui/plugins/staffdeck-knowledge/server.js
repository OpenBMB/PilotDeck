/**
 * staffdeck-knowledge plugin server — local fallback for the StaffDeck copy
 * route when no StaffDeck backend is configured.
 */
import {
  handleStaffDeckCopyCall,
  startLocalFallbackServer,
} from '../shared/local-fallback-server.mjs';

startLocalFallbackServer({
  'POST /api/modules/staffdeck-copy/call': (req, res, userId) => handleStaffDeckCopyCall(req, res, userId),
});
