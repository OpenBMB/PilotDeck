import { constants, createWriteStream, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { isPathInsideOrEqual } from './pathSafety.js';

const migrations = new Map();
const unsafe = message => Object.assign(new Error(message), { code: 'GENERAL_WORKSPACE_UNSAFE' });
const statOrNull = file => fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
});
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameIdentity = (left, right) => left && right
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

async function physicalPath(file) {
    try { return await fs.realpath(file); }
    catch (error) {
        const parent = path.dirname(file);
        if (error.code !== 'ENOENT' || parent === file) throw error;
        return path.join(await physicalPath(parent), path.basename(file));
    }
}

async function openRegularFile(file, expected, root) {
    const realFile = await fs.realpath(file);
    if (!isPathInsideOrEqual(root, realFile)) throw unsafe('Legacy General file escapes its workspace.');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const actual = await handle.stat();
        if (!actual.isFile() || !sameIdentity(identity(expected), identity(actual))) {
            throw unsafe('General workspace file changed while preparing migration.');
        }
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function digest(file, expected, root) {
    const handle = await openRegularFile(file, expected, root);
    try {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream()) hash.update(chunk);
        return hash.digest('hex');
    } finally { await handle.close(); }
}

async function equalFiles(source, sourceStat, destination, destinationStat, roots) {
    if (!destinationStat?.isFile() || destinationStat.isSymbolicLink() || sourceStat.size !== destinationStat.size) return false;
    return await digest(source, sourceStat, roots.source) === await digest(destination, destinationStat, roots.destination);
}

function recoveryName(name, attempt, directory, sourceLabel) {
    const parsed = path.parse(name);
    const suffix = ` (from ${sourceLabel}${attempt === 1 ? '' : ` ${attempt}`})`;
    const shorten = (text, bytes) => {
        let result = '';
        for (const character of text) {
            if (Buffer.byteLength(result + character) > bytes) break;
            result += character;
        }
        return result;
    };
    // Leave room for the suffix on filesystems with a 255-byte name limit.
    return directory ? `${shorten(name, 180)}${suffix}`
        : `${shorten(parsed.name, 160)}${suffix}${shorten(parsed.ext, 40)}`;
}

async function assertInside(root, directory) {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isPathInsideOrEqual(root, await fs.realpath(directory))) {
        throw unsafe('General migration directory is not a safe workspace directory.');
    }
}

async function publishFile(source, stat, destination, roots) {
    await assertInside(roots.destination, path.dirname(destination));
    const temporary = path.join(path.dirname(destination), `.pilotdeck-migration-${randomUUID()}.tmp`);
    const input = await openRegularFile(source, stat, roots.source);
    let created = false;
    try {
        // Copy first, then publish a complete independent file with an atomic,
        // no-overwrite link. Killing the app cannot leave a partial report.md.
        const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
        output.once('open', () => { created = true; });
        await pipeline(input.createReadStream(), output);
        await assertInside(roots.destination, path.dirname(destination));
        await fs.link(temporary, destination);
    } finally {
        await input.close();
        if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    // Apply read-only/executable permissions after unlinking the staging name;
    // Windows refuses to unlink a file whose read-only attribute is already set.
    await fs.chmod(destination, stat.mode & 0o777);
}

async function copyTree(source, destination, roots, report) {
    await assertInside(roots.source, source);
    await assertInside(roots.destination, destination);
    for (const name of (await fs.readdir(source)).sort()) {
        // Workspace ownership belongs to the destination, never to an old copy.
        if (name === '.pilotdeck-workspace') continue;
        const from = path.join(source, name);
        const sourceStat = await fs.lstat(from);
        const relativeSource = path.relative(roots.source, from);
        if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
            report.skipped.push(relativeSource);
            continue;
        }
        for (let attempt = 0; ; attempt++) {
            if (attempt > 1000) throw new Error(`Too many migration conflicts for ${relativeSource}`);
            const to = path.join(destination, attempt === 0 ? name : recoveryName(name, attempt, sourceStat.isDirectory(), roots.sourceLabel));
            let existing = await statOrNull(to);
            if (sourceStat.isDirectory()) {
                if (!existing) {
                    await fs.mkdir(to, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
                    existing = await fs.lstat(to);
                }
                if (existing.isSymbolicLink() || !existing.isDirectory()) continue;
                await copyTree(from, to, roots, report);
            } else {
                if (existing) {
                    if (!await equalFiles(from, sourceStat, to, existing, roots)) continue;
                } else {
                    try {
                        await publishFile(from, sourceStat, to, roots);
                        report.copied++;
                    } catch (error) {
                        // Another request/process may have published this name.
                        if (error.code !== 'EEXIST') throw error;
                        existing = await statOrNull(to);
                        if (!await equalFiles(from, sourceStat, to, existing, roots)) continue;
                    }
                }
            }
            if (attempt > 0) report.conflicts.push({ source: relativeSource, destination: path.relative(roots.destination, to) });
            break;
        }
    }
}

async function migrate({ source, destination, pilotHome, sourceLabel = 'general' }) {
    const sourceStat = await statOrNull(source);
    if (!sourceStat) return;
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw unsafe('Legacy General workspace is not a safe directory.');
    const destinationStat = await fs.lstat(destination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) throw unsafe('New General workspace is not a safe directory.');
    const [realSource, realDestination, realPilotHome] = await Promise.all([
        fs.realpath(source), fs.realpath(destination), physicalPath(path.resolve(pilotHome)),
    ]);
    for (const [left, right] of [[realSource, realDestination], [realSource, realPilotHome], [realDestination, realPilotHome]]) {
        if (isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left)) {
            throw unsafe('General migration directories must be separate from each other and PILOT_HOME.');
        }
    }
    const destinationIdentity = identity(await fs.stat(realDestination));
    const key = createHash('sha256').update(`${realSource}\0${realDestination}`).digest('hex').slice(0, 24);
    const stateDirectory = path.join(realPilotHome, 'migrations');
    const marker = path.join(stateDirectory, `general-workspace-v1-${key}.json`);
    const stateStat = await statOrNull(stateDirectory);
    if (stateStat && (stateStat.isSymbolicLink() || !stateStat.isDirectory())) throw unsafe('General migration state directory is unsafe.');
    const markerStat = await statOrNull(marker);
    if (markerStat && (markerStat.isSymbolicLink() || !markerStat.isFile())) throw unsafe('General migration marker is unsafe.');
    if (markerStat) {
        let completed;
        try { completed = JSON.parse(await fs.readFile(marker, 'utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (completed?.version === 1 && completed.source === realSource && completed.destination === realDestination
            && sameIdentity(completed.destinationIdentity, destinationIdentity)) return;
    }
    const report = { version: 1, source: realSource, destination: realDestination, destinationIdentity, copied: 0, conflicts: [], skipped: [] };
    await copyTree(realSource, realDestination, { source: realSource, destination: realDestination, sourceLabel }, report);
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await assertInside(realPilotHome, stateDirectory);
    const temporary = path.join(stateDirectory, `${key}-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, marker);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    console.info(`[General workspace] Migrated ${report.copied} files; preserved ${report.conflicts.length} conflicts and skipped ${report.skipped.length} links/special files. Report: ${marker}`);
}

/** One migration per source/destination pair; concurrent browse/send requests share it. */
export function migrateLegacyGeneralWorkspace(options) {
    const key = JSON.stringify(options);
    if (migrations.has(key)) return migrations.get(key);
    const operation = migrate(options).finally(() => migrations.delete(key));
    migrations.set(key, operation);
    return operation;
}
