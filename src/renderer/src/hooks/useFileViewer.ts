import { useCallback, useMemo, useState } from "react";

export interface SelectedFile {
  resourceName: string;
  absolutePath: string;
  relativePath: string;
}

function isHtmlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".html") || path.toLowerCase().endsWith(".htm");
}

export interface UseFileViewerReturn {
  selectedFile: SelectedFile | null;
  fileContent: string | null;
  fileLoading: boolean;
  viewMode: "code" | "preview";
  setViewMode: (mode: "code" | "preview") => void;
  editMode: boolean;
  editContent: string;
  saving: boolean;
  modified: boolean;
  selectedIsHtml: boolean;
  handleFileClick: (
    resourceName: string,
    absolutePath: string,
    relativePath: string,
  ) => Promise<void>;
  toggleEditMode: () => void;
  handleSave: () => Promise<void>;
  setEditContent: (content: string) => void;
  setModified: (modified: boolean) => void;
  clearForResource: (resourceName: string) => void;
}

export function useFileViewer(): UseFileViewerReturn {
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"code" | "preview">("code");
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [modified, setModified] = useState(false);

  const selectedIsHtml = useMemo(
    () => selectedFile !== null && isHtmlFile(selectedFile.absolutePath),
    [selectedFile],
  );

  const handleFileClick = useCallback(
    async (resourceName: string, absolutePath: string, relativePath: string) => {
      setSelectedFile({ resourceName, absolutePath, relativePath });
      setViewMode(isHtmlFile(absolutePath) ? "preview" : "code");
      setEditMode(false);
      setModified(false);
      setFileLoading(true);
      try {
        const content = await window.api.readFile(absolutePath);
        setFileContent(content);
        setEditContent(content);
      } catch {
        setFileContent("(Could not read file)");
        setEditContent("");
      } finally {
        setFileLoading(false);
      }
    },
    [],
  );

  const toggleEditMode = useCallback(() => {
    if (editMode && modified) {
      setEditContent(fileContent ?? "");
      setModified(false);
    }
    setEditMode((prev) => !prev);
  }, [editMode, modified, fileContent]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await window.api.writeFile(selectedFile.absolutePath, editContent);
      setFileContent(editContent);
      setModified(false);
      setEditMode(false);
    } catch {
      // Stay in edit mode on error
    } finally {
      setSaving(false);
    }
  }, [selectedFile, editContent]);

  const clearForResource = useCallback(
    (resourceName: string) => {
      if (selectedFile?.resourceName === resourceName) {
        setSelectedFile(null);
        setFileContent(null);
      }
    },
    [selectedFile],
  );

  return {
    selectedFile,
    fileContent,
    fileLoading,
    viewMode,
    setViewMode,
    editMode,
    editContent,
    saving,
    modified,
    selectedIsHtml,
    handleFileClick,
    toggleEditMode,
    handleSave,
    setEditContent,
    setModified,
    clearForResource,
  };
}
