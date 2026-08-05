const normalizePathForUrl = (value) => String(value || '').replace(/\\/g, '/');

const getProjectRelativePath = (filePath, projectRoot) => {
  const normalizedFilePath = normalizePathForUrl(filePath);
  const normalizedRoot = normalizePathForUrl(projectRoot).replace(/\/+$/, '');

  if (normalizedRoot && normalizedFilePath === normalizedRoot) {
    return '';
  }

  if (normalizedRoot && normalizedFilePath.startsWith(normalizedRoot + '/')) {
    return normalizedFilePath.slice(normalizedRoot.length + 1);
  }

  return normalizedFilePath.replace(/^\/+/, '');
};

const encodePathSegments = (relativePath) =>
  String(relativePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const CSRF_STORAGE_KEY = 'pilotdeck-csrf-token';

export const setCsrfToken = (token) => {
  if (token) sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  else sessionStorage.removeItem(CSRF_STORAGE_KEY);
};

export const getCsrfToken = () => sessionStorage.getItem(CSRF_STORAGE_KEY);

// Cookie credentials are attached to same-origin media/SSE URLs by the browser.
const appendAuthToken = (url) => url;

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const {
    suppressServerErrorToast = false,
    ...fetchOptions
  } = options;

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(fetchOptions.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  const method = String(fetchOptions.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) defaultHeaders['X-CSRF-Token'] = csrfToken;
  }

  return fetch(url, {
    ...fetchOptions,
    credentials: 'same-origin',
    headers: {
      ...defaultHeaders,
      ...fetchOptions.headers,
    },
  }).then((response) => {
    if (!suppressServerErrorToast && response.status >= 500) {
      window.dispatchEvent(new CustomEvent('pilotdeck:toast', {
        detail: { kind: 'error', message: `Server error (${response.status}): ${response.statusText || 'Internal Server Error'}` },
      }));
    }
    return response;
  });
};

export const createWebHttpAgentStatus = ({
  event = 'web_http_request_failed',
  message,
  code,
  status,
  statusText,
  userHint,
  scope = 'http',
  detail = {},
} = {}) => ({
  type: 'agent_status',
  event,
  detail: Object.fromEntries(Object.entries({
    message: message || `Request failed${status ? ` (${status})` : ''}.`,
    code: code || event,
    severity: 'error',
    visible: true,
    userHint: userHint || defaultWebHttpUserHint(status),
    scope,
    source: 'web_http',
    status,
    statusText,
    ...detail,
  }).filter(([, value]) => value !== undefined)),
});

export const extractAgentStatusFromBody = (body) => {
  if (!body || typeof body !== 'object') return null;
  const status = body.agent_status || body.agentStatus;
  if (
    status &&
    status.type === 'agent_status' &&
    typeof status.event === 'string' &&
    status.detail &&
    typeof status.detail === 'object'
  ) {
    return status;
  }
  return null;
};

export const readAgentStatusErrorFromResponse = async (response, options = {}) => {
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  const status = extractAgentStatusFromBody(body) || createWebHttpAgentStatus({
    event: options.event || 'web_http_request_failed',
    code: options.code,
    message: options.message || response.statusText || `Request failed with HTTP ${response.status}.`,
    status: response.status,
    statusText: response.statusText,
    userHint: options.userHint,
    scope: options.scope || 'http',
  });
  return {
    status,
    message: formatAgentStatusForDisplay(status),
  };
};

export const formatAgentStatusForDisplay = (status) => {
  const detail = status?.detail || {};
  const message = typeof detail.message === 'string' && detail.message.trim()
    ? detail.message.trim()
    : 'Request failed.';
  const hint = typeof detail.userHint === 'string' && detail.userHint.trim()
    ? detail.userHint.trim()
    : '';
  return hint ? `${message}\n${hint}` : message;
};

function defaultWebHttpUserHint(status) {
  if (status === 401 || status === 403) return 'Check authentication and permissions, then retry.';
  if (status === 429) return 'Wait for the current request or rate limit to clear, then retry.';
  if (status === 413) return 'Reduce the request size and retry.';
  if (status && status >= 500) return 'The local server or gateway is unavailable. Retry after it recovers.';
  return 'Check the request and retry.';
}

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status', { credentials: 'same-origin' }),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    enable: (displayName, password) => fetch('/api/auth/enable', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
    changePassword: (currentPassword, newPassword) => authenticatedFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  },

  account: {
    get: () => authenticatedFetch('/api/account'),
    update: (payload) => authenticatedFetch('/api/account', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
    sessions: () => authenticatedFetch('/api/account/sessions'),
    revokeSession: (sessionId) => authenticatedFetch(`/api/account/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  },

  admin: {
    users: () => authenticatedFetch('/api/admin/users'),
    createUser: (payload) => authenticatedFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    updateUser: (userId, payload) => authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
    resetPassword: (userId) => authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
    }),
    revokeUserSessions: (userId) => authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {
      method: 'POST',
    }),
    auditEvents: (limit = 100) => authenticatedFetch(`/api/admin/audit-events?limit=${encodeURIComponent(limit)}`),
    instances: () => authenticatedFetch('/api/admin/instances'),
    approveInstance: (instanceId) => authenticatedFetch(`/api/admin/instances/${encodeURIComponent(instanceId)}/test-and-approve`, {
      method: 'POST',
    }),
    rejectInstance: (instanceId) => authenticatedFetch(`/api/admin/instances/${encodeURIComponent(instanceId)}/reject`, {
      method: 'POST',
    }),
  },

  instances: {
    list: () => authenticatedFetch('/api/instances'),
    create: (payload) => authenticatedFetch('/api/instances', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    update: (instanceId, payload) => authenticatedFetch(`/api/instances/${encodeURIComponent(instanceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
    remove: (instanceId) => authenticatedFetch(`/api/instances/${encodeURIComponent(instanceId)}`, {
      method: 'DELETE',
    }),
    setDefault: (instanceId) => authenticatedFetch(`/api/instances/${encodeURIComponent(instanceId)}/default`, {
      method: 'POST',
    }),
    setProjectMapping: (instanceId, payload) => authenticatedFetch(`/api/instances/${encodeURIComponent(instanceId)}/project-mappings`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: () => authenticatedFetch('/api/projects'),
  groups: () => authenticatedFetch('/api/groups'),
  createGroup: (payload) => authenticatedFetch('/api/groups', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  group: (groupId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}`),
  updateGroup: (groupId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  archiveGroup: (groupId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  }),
  groupConversations: (groupId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/conversations`),
  createGroupConversation: (groupId, payload = {}) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/conversations`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateGroupConversation: (groupId, conversationId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  archiveGroupConversation: (groupId, conversationId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  }),
  groupMessages: (groupId, conversationId, limit = 100, before = '') => {
    const params = new URLSearchParams({ conversationId, limit: String(limit) });
    if (before) params.set('before', before);
    return authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/messages?${params.toString()}`);
  },
  groupMessageImageUrl: (groupId, messageId, imageIndex) => appendAuthToken(
    `/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/images/${encodeURIComponent(String(imageIndex))}`,
  ),
  sendGroupMessage: (groupId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  stopGroupConversation: (groupId, conversationId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/conversations/${encodeURIComponent(conversationId)}/stop`, {
    method: 'POST',
  }),
  uploadProjectAttachments: (projectName, attachments) => {
    const formData = new FormData();
    for (const attachment of attachments) formData.append('attachments', attachment);
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/upload-attachments`, {
      method: 'POST',
      body: formData,
    });
  },
  markGroupRead: (groupId, conversationId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/read`, {
    method: 'POST',
    body: JSON.stringify({ conversationId }),
  }),
  groupParticipants: (groupId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/participants`),
  groupParticipantCandidates: (groupId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/participant-candidates`),
  addGroupParticipant: (groupId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/participants`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateGroupParticipant: (groupId, userId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/participants/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  removeGroupParticipant: (groupId, userId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/participants/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  }),
  updateMyGroupParticipation: (groupId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/my-participation`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  availableGroupMembers: () => authenticatedFetch('/api/groups/available-members'),
  addGroupMember: (groupId, payload) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  removeGroupMember: (groupId, memberId) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
  }),
  reorderGroupMembers: (groupId, memberIds) => authenticatedFetch(`/api/groups/${encodeURIComponent(groupId)}/member-order`, {
    method: 'PUT',
    body: JSON.stringify({ memberIds }),
  }),
  alwaysOnDashboardEvents: (limit = 200, since) =>
    authenticatedFetch(`/api/always-on/events?limit=${encodeURIComponent(limit)}${since ? `&since=${encodeURIComponent(since)}` : ''}`),
  allCronJobs: () =>
    authenticatedFetch('/api/always-on/cron-jobs'),
  cronCreate: (payload) =>
    authenticatedFetch('/api/always-on/cron-jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  cronRunNow: (taskId) =>
    authenticatedFetch(`/api/always-on/cron-jobs/${encodeURIComponent(taskId)}/run-now`, { method: 'POST' }),
  cronStop: (taskId) =>
    authenticatedFetch(`/api/always-on/cron-jobs/${encodeURIComponent(taskId)}/stop`, { method: 'POST' }),
  cronDelete: (taskId) =>
    authenticatedFetch(`/api/always-on/cron-jobs/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
  projectDiscoveryContext: (projectName) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/discovery-context`),
  projectDiscoveryPlans: (projectName) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/discovery-plans`),
  executeProjectDiscoveryPlan: (projectName, planId, body = {}) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/discovery-plans/${encodeURIComponent(planId)}/execute`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  discoveryPlanReport: (projectName, planId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/discovery-plans/${encodeURIComponent(planId)}/report`),
  projectWorkCycles: (projectName) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/work-cycles`),
  applyWorkCycle: (projectName, cycleId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/work-cycles/${encodeURIComponent(cycleId)}/apply`, {
      method: 'POST',
    }),
  archiveWorkCycle: (projectName, cycleId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/work-cycles/${encodeURIComponent(cycleId)}/archive`, {
      method: 'POST',
    }),
  sessions: (projectName, limit = 5, offset = 0) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  projectMembers: (projectName) => authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/members`),
  projectMemberCandidates: (projectName) => authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/member-candidates`),
  setProjectMember: (projectName, userId, role) => authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/members/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  }),
  removeProjectMember: (projectName, userId) => authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  }),
  // Unified endpoint — all providers through one URL
  unifiedSessionMessages: (sessionId, provider = 'claude', { projectName = '', projectPath = '', limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.append('provider', provider);
    if (projectName) params.append('projectName', projectName);
    if (projectPath) params.append('projectPath', projectPath);
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectName, displayName) =>
    authenticatedFetch(`/api/projects/${projectName}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  deleteSession: (projectName, sessionId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.sessionKind) params.append('sessionKind', opts.sessionKind);
    if (opts.parentSessionId) params.append('parentSessionId', opts.parentSessionId);
    if (opts.relativeTranscriptPath) params.append('relativeTranscriptPath', opts.relativeTranscriptPath);
    const query = params.toString();
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`, {
      method: 'DELETE',
    });
  },
  renameSession: (sessionId, summary, provider) =>
    authenticatedFetch(`/api/sessions/${sessionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  forkSession: (sessionId, { projectPath, fromEntryId }) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ projectPath, fromEntryId }),
    }),
  deleteProject: (projectName, force = false) =>
    authenticatedFetch(`/api/projects/${projectName}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  searchConversationsUrl: (query, limit = 50) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return `/api/search/conversations?${params.toString()}`;
  },
  createProject: (path) =>
    authenticatedFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    authenticatedFetch('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  fileContentUrl: (projectName, filePath, options = {}) => {
    const params = new URLSearchParams({ path: filePath });
    if (options.download) params.set('download', '1');
    if (options.cacheKey !== undefined && options.cacheKey !== null) {
      params.set('_', String(options.cacheKey));
    }
    return appendAuthToken(`/api/projects/${encodeURIComponent(projectName)}/files/content?${params.toString()}`);
  },
  readFileBlob: (projectName, filePath) =>
    authenticatedFetch(api.fileContentUrl(projectName, filePath)),
  fileContentSha256: (projectName, filePath) => {
    const params = new URLSearchParams({ path: filePath, sha256: '1' });
    return authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/files/content?${params.toString()}`,
      { method: 'HEAD', cache: 'no-store' },
    );
  },
  officePdfPreviewUrl: (projectName, filePath, options = {}) => {
    const params = new URLSearchParams({ path: filePath });
    if (options.force) {
      params.set('force', '1');
    }
    if (options.cacheKey !== undefined && options.cacheKey !== null) {
      params.set('_', String(options.cacheKey));
    }
    return appendAuthToken(`/api/projects/${encodeURIComponent(projectName)}/files/preview/pdf?${params.toString()}`);
  },
  readOfficePdfPreviewBlob: (projectName, filePath, options = {}) => {
    return authenticatedFetch(api.officePdfPreviewUrl(projectName, filePath, {
      force: options.force,
      cacheKey: options.force ? Date.now() : options.cacheKey,
    }), {
      cache: 'no-store',
    });
  },
  preflightOfficePdfPreview: (projectName, filePath, options = {}) =>
    authenticatedFetch(api.officePdfPreviewUrl(projectName, filePath, {
      force: options.force,
      cacheKey: options.cacheKey,
    }), {
      cache: 'no-store',
      headers: {
        Range: 'bytes=0-0',
      },
      signal: options.signal,
    }),
  spreadsheetPreviewManifest: (projectName, filePath, options = {}) => {
    const params = new URLSearchParams({ path: filePath });
    if (options.force) params.set('force', '1');
    if (options.cacheKey !== undefined && options.cacheKey !== null) {
      params.set('_', String(options.cacheKey));
    }
    return authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/files/preview/spreadsheet/manifest?${params.toString()}`,
      { cache: 'no-store', signal: options.signal },
    );
  },
  spreadsheetInteractivePreview: (projectName, filePath, options = {}) => {
    const params = new URLSearchParams({ path: filePath });
    if (options.force) params.set('force', '1');
    if (options.cacheKey !== undefined && options.cacheKey !== null) {
      params.set('_', String(options.cacheKey));
    }
    return authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/files/preview/spreadsheet/data?${params.toString()}`,
      { cache: 'no-store', signal: options.signal },
    );
  },
  spreadsheetSheetPreviewUrl: (projectName, filePath, sheetIndex, options = {}) => {
    const params = new URLSearchParams({
      path: filePath,
      sheet: String(sheetIndex),
    });
    if (options.force) params.set('force', '1');
    if (options.cacheKey !== undefined && options.cacheKey !== null) {
      params.set('_', String(options.cacheKey));
    }
    return appendAuthToken(
      `/api/projects/${encodeURIComponent(projectName)}/files/preview/spreadsheet/sheet?${params.toString()}`,
    );
  },
  preflightSpreadsheetSheetPreview: (projectName, filePath, sheetIndex, options = {}) =>
    authenticatedFetch(api.spreadsheetSheetPreviewUrl(projectName, filePath, sheetIndex, {
      force: options.force,
      cacheKey: options.cacheKey,
    }), {
      cache: 'no-store',
      headers: {
        Range: 'bytes=0-0',
      },
      signal: options.signal,
    }),
  officePreviewStatus: (options = {}) => {
    const params = new URLSearchParams();
    if (options.refresh) params.set('refresh', '1');
    const query = params.toString();
    return authenticatedFetch(`/api/office-preview/status${query ? `?${query}` : ''}`);
  },
  pilotDeckConfig: () =>
    authenticatedFetch('/api/config'),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, options),

  // File operations
  createFile: (projectName, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectName, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectName, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {},
    }),

  projectPreviewUrl: (projectName, filePath, projectRoot) => {
    const relativePath = getProjectRelativePath(filePath, projectRoot);
    const encoded = encodePathSegments(relativePath);
    return appendAuthToken(
      `/api/projects/${encodeURIComponent(projectName)}/preview/${encoded}`,
    );
  },

  downloadProjectZip: (projectName) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectName)}/download`),

  fileDownloadUrl: (projectName, filePath) =>
    api.fileContentUrl(projectName, filePath, { download: true }),

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) =>
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
