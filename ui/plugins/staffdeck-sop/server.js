/**
 * staffdeck-sop plugin server — local fallback for the core SOP management,
 * public SDK, StaffDeck copy and host-capabilities routes when no StaffDeck
 * backend is configured.
 */
import {
  handleStaffDeckCopyCall,
  handleSopManagementCall,
  handleSopManagementStatus,
  handleStaffdeckSdkCall,
  handleStaffdeckSdkEvents,
  handleHostCapabilitiesCall,
  startLocalFallbackServer,
} from '../shared/local-fallback-server.mjs';

startLocalFallbackServer({
  'GET /api/modules/sop/management': (req, res, userId) => handleSopManagementStatus(req, res, userId),
  'POST /api/modules/sop/management/call': (req, res) => handleSopManagementCall(req, res),
  'POST /api/modules/staffdeck-sdk/call': (req, res) => handleStaffdeckSdkCall(req, res),
  'GET /api/modules/staffdeck-sdk/events': (req, res) => handleStaffdeckSdkEvents(req, res),
  'POST /api/modules/staffdeck-copy/call': (req, res, userId) => handleStaffDeckCopyCall(req, res, userId),
  'POST /api/modules/host-capabilities/call': (req, res) => handleHostCapabilitiesCall(req, res),
});
