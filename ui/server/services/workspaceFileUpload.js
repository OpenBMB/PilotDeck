import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readUploadLimits } from './uploadLimits.js';

function uploadError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function relativePath(value, allowEmpty = false) {
  if (typeof value !== 'string') throw uploadError('UPLOAD_INVALID_PATH', 'Invalid destination path.');
  const normalized = value.replace(/\\/g, '/');
  if (allowEmpty && (!normalized || normalized === '.')) return '';
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
    || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw uploadError('UPLOAD_INVALID_PATH', 'Destination must be a relative path inside the workspace.');
  }
  return normalized;
}

// Do not traverse directory symlinks, including the staging directory itself.
async function ensureDirectory(root, relative) {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw uploadError('UPLOAD_INVALID_PATH', 'Destination contains a symlink or is not a directory.');
    }
  }
  return current;
}

// lstat also catches dangling symlinks. Inspect parents without creating them
// or following directory symlinks during the preflight check.
async function destinationExists(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (i === parts.length - 1) return true;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw uploadError('UPLOAD_INVALID_PATH', 'Destination contains a symlink or is not a directory.');
    }
  }
  return false;
}

export function createWorkspaceUploadCheckHandler({ resolveProject, getLimits = readUploadLimits }) {
  return async (req, res) => {
    try {
      const root = await fs.realpath(await resolveProject(req.params.projectName));
      const target = relativePath(req.body?.targetPath || '', true);
      const input = req.body?.relativePaths;
      if (!Array.isArray(input) || input.length < 1 || input.length > getLimits().maxFiles) {
        throw uploadError('UPLOAD_MANIFEST_INVALID', 'Invalid file list.');
      }
      const names = input.map(name => relativePath(name));
      if (new Set(names).size !== names.length) throw uploadError('UPLOAD_MANIFEST_INVALID', 'Duplicate destination paths.');
      const conflicts = [];
      for (const name of names) {
        if (await destinationExists(root, path.posix.join(target, name))) conflicts.push(name);
      }
      if (conflicts.length) {
        return res.status(409).json({ error: { code: 'UPLOAD_FILE_EXISTS', message: 'Destination already exists. Rename the file before uploading.' }, conflicts });
      }
      return res.json({ success: true });
    } catch (error) {
      return res.status(error.status || 500).json({ error: { code: error.code || 'UPLOAD_FAILED', message: error.message } });
    }
  };
}

// Creating a hard link publishes a complete file atomically and fails with
// EEXIST if any file, directory, or symlink already occupies the destination.
// Unlike an exists-check followed by rename, this also protects concurrent uploads.
export async function publishWorkspaceFile(source, destination, signal, io = fs) {
  try {
    await io.link(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const temporary = path.join(path.dirname(destination), `.pilotdeck-upload-${randomUUID()}`);
    try {
      await io.copyFile(source, temporary, constants.COPYFILE_EXCL);
      if (signal.aborted) throw uploadError('UPLOAD_CANCELLED', 'Upload cancelled.');
      await io.link(temporary, destination);
    } finally {
      await io.rm(temporary, { force: true }).catch(error => console.warn('[workspace-upload] Temporary file cleanup failed:', error.message));
    }
  }
}

export function createWorkspaceFileUploadHandler({ resolveProject, getLimits = readUploadLimits }) {
  const active = new Map();
  return async (req, res) => {
    let root;
    let staging;
    let registered = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) abort(); };
    const writes = new Set();
    req.once('aborted', abort);
    res.once('close', onClose);
    try {
      root = await fs.realpath(await resolveProject(req.params.projectName));
      const limits = getLimits();
      if ((active.get(root) || 0) >= limits.maxConcurrentPerProject) {
        throw uploadError('UPLOAD_CONCURRENCY_LIMIT', 'Too many uploads in this workspace. Please retry shortly.', 429);
      }
      active.set(root, (active.get(root) || 0) + 1);
      registered = true;
      const temporaryRoot = await ensureDirectory(root, '.tmp');
      staging = await fs.mkdtemp(path.join(temporaryRoot, 'workspace-upload-'));
      let totalBytes = 0;
      const storage = {
        _handleFile(_request, file, callback) {
          const destination = path.join(staging, randomUUID());
          let size = 0;
          const meter = new Transform({
            transform(chunk, _encoding, done) {
              size += chunk.length;
              totalBytes += chunk.length;
              if (totalBytes > limits.maxTaskBytes) {
                done(uploadError('UPLOAD_TASK_TOO_LARGE', 'Upload exceeds the total size limit.', 413));
              } else done(null, chunk);
            },
          });
          const writing = pipeline(file.stream, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
          writes.add(writing);
          writing.then(() => callback(null, { path: destination, size }), callback)
            .finally(() => writes.delete(writing));
        },
        _removeFile(_request, file, callback) { fs.rm(file.path, { force: true }).then(() => callback(null), callback); },
      };
      const middleware = multer({ storage, limits: {
        fileSize: limits.maxFileBytes, files: limits.maxFiles, fields: 3, fieldSize: 1024 * 1024,
      } }).array('files', limits.maxFiles);
      await new Promise((resolve, reject) => {
        const aborted = () => reject(uploadError('UPLOAD_CANCELLED', 'Upload cancelled.'));
        if (controller.signal.aborted) return aborted();
        controller.signal.addEventListener('abort', aborted, { once: true });
        middleware(req, res, error => {
          controller.signal.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve();
        });
      });
      if (controller.signal.aborted) return;
      const files = req.files || [];
      if (!files.length) throw uploadError('UPLOAD_MANIFEST_INVALID', 'No files provided.');
      const target = relativePath(req.body.targetPath || '', true);
      let names;
      try { names = req.body.relativePaths ? JSON.parse(req.body.relativePaths) : files.map(file => file.originalname); }
      catch { throw uploadError('UPLOAD_MANIFEST_INVALID', 'Invalid file paths.'); }
      if (!Array.isArray(names) || names.length !== files.length) {
        throw uploadError('UPLOAD_MANIFEST_INVALID', 'File paths do not match uploaded files.');
      }
      names = names.map(name => relativePath(name));
      if (new Set(names).size !== names.length) throw uploadError('UPLOAD_MANIFEST_INVALID', 'Duplicate destination paths.');
      // Validate the complete batch before moving any file into the workspace.
      if (req.body.sizes) {
        let sizes;
        try { sizes = JSON.parse(req.body.sizes); } catch { /* rejected below */ }
        if (!Array.isArray(sizes) || sizes.length !== files.length || sizes.some((size, i) => size !== files[i].size)) {
          throw uploadError('UPLOAD_INTEGRITY_MISMATCH', 'Received file sizes do not match the upload.', 422);
        }
      }
      for (const name of names) {
        await ensureDirectory(root, path.posix.dirname(path.posix.join(target, name)) === '.' ? '' : path.posix.dirname(path.posix.join(target, name)));
      }
      const saved = [];
      const errors = [];
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) break;
        const file = files[i];
        const name = names[i];
        const relative = path.posix.join(target, name);
        const destination = path.join(root, relative);
        try {
          // Recheck parents immediately before publishing the staged file.
          await ensureDirectory(root, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
          await publishWorkspaceFile(file.path, destination, controller.signal);
          saved.push({ name, path: destination, size: file.size, mimeType: file.mimetype });
        } catch (error) {
          errors.push(error.code === 'EEXIST'
            ? { name, code: 'UPLOAD_FILE_EXISTS', message: 'Destination already exists. Rename the file before uploading.' }
            : { name, code: error.code || 'UPLOAD_SAVE_FAILED', message: error.message });
        }
      }
      if (!controller.signal.aborted) res.status(errors.length ? 207 : 200).json({ success: errors.length === 0, files: saved, errors, targetPath: path.join(root, target) });
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) {
        const code = error.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_FILE_TOO_LARGE'
          : ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code) ? 'UPLOAD_TOO_MANY_FILES' : error.code || 'UPLOAD_FAILED';
        const message = code === 'UPLOAD_FILE_TOO_LARGE' ? 'File exceeds the upload size limit.'
          : code === 'UPLOAD_TOO_MANY_FILES' ? 'Too many files in one upload.' : error.message;
        res.status(error.status || (code.startsWith('UPLOAD_') ? 400 : 500)).json({ error: { code, message } });
      }
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', onClose);
      await Promise.allSettled([...writes]);
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(error => console.warn('[workspace-upload] Staging cleanup failed:', error.message));
      if (registered) {
        const remaining = (active.get(root) || 1) - 1;
        if (remaining) active.set(root, remaining); else active.delete(root);
      }
    }
  };
}
