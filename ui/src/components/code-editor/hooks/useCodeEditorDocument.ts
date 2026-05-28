import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../utils/api';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  // `content` is the editor's authoritative buffer. We never put an error
  // placeholder in here — if a load fails, the surface is hidden and the
  // user sees an error panel instead. Otherwise a stray Ctrl+S would
  // persist the placeholder text and overwrite the user's real file.
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const fileProjectName = file.projectName ?? projectPath;
  const filePath = file.path;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;

  useEffect(() => {
    let cancelled = false;

    const loadFileContent = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        setIsBinary(false);

        if (isBinaryFile(file.name)) {
          if (cancelled) return;
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          if (cancelled) return;
          setContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectName) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectName, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (cancelled) return;
        setContent(data.content ?? '');
      } catch (error) {
        if (cancelled) return;
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        // IMPORTANT: do not pour the error message into `content`. A previous
        // version of this code did `setContent('// Error loading file: ...')`
        // which silently became user-editable buffer content and got persisted
        // back to disk on the next save, destroying the real file.
        setLoadError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadFileContent();

    return () => {
      cancelled = true;
    };
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, filePath, fileProjectName, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const handleSave = useCallback(async () => {
    // Guard against persisting a buffer that was never successfully loaded.
    // Without this, a transient read failure followed by Ctrl+S would write
    // empty/stale content to disk.
    if (loading) {
      setSaveError('File is still loading');
      return;
    }
    if (loadError) {
      setSaveError('Cannot save: file failed to load. Reload first.');
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectName) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectName, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectName, loadError, loading]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    loading,
    loadError,
    reload,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    projectName: fileProjectName,
    handleSave,
    handleDownload,
  };
};
