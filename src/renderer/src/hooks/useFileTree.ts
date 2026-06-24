import type { GenerationResult } from "@renderer/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

type ResourceFile = {
  name: string;
  relativePath: string;
  absolutePath: string;
};

export interface UseFileTreeReturn {
  serverResources: string[];
  expandedResource: string | null;
  resourceFiles: Map<string, ResourceFile[]>;
  loadingResources: boolean;
  loadingFiles: string | null;
  confirmDelete: string | null;
  deleting: string | null;
  setConfirmDelete: (name: string | null) => void;
  toggleResource: (name: string) => void;
  refreshResources: () => Promise<void>;
  handleDelete: (name: string) => Promise<void>;
  controlling: { name: string; action: ResourceAction } | null;
  controlError: { name: string; error: string } | null;
  controlResource: (name: string, action: ResourceAction) => Promise<void>;
}

export type ResourceAction = "restart" | "stop" | "start";

export function useFileTree(
  localPath: string,
  lastResult: GenerationResult | null,
  onDeleteResource?: (name: string) => void,
  onResourceDeleted?: (name: string) => void,
) {
  const [serverResources, setServerResources] = useState<string[]>([]);
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [resourceFiles, setResourceFiles] = useState<Map<string, ResourceFile[]>>(new Map());
  const [loadingResources, setLoadingResources] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [controlling, setControlling] = useState<{ name: string; action: ResourceAction } | null>(
    null,
  );
  const [controlError, setControlError] = useState<{ name: string; error: string } | null>(null);

  // Refresh resource list
  const refreshResources = useCallback(async () => {
    if (!localPath) return;
    setLoadingResources(true);
    try {
      const resources = await window.api.listResources(localPath);
      setServerResources(resources.sort());
    } catch {
      setServerResources([]);
    } finally {
      setLoadingResources(false);
    }
  }, [localPath]);

  // Delete a resource
  const handleDelete = useCallback(
    async (name: string) => {
      setDeleting(name);
      setConfirmDelete(null);
      try {
        await window.api.deleteResource(localPath, name);
        await refreshResources();
        setResourceFiles((prev) => {
          const next = new Map(prev);
          next.delete(name);
          return next;
        });
        setExpandedResource((prev) => (prev === name ? null : prev));
        onDeleteResource?.(name);
        onResourceDeleted?.(name);
      } catch {
        await refreshResources();
      } finally {
        setDeleting(null);
      }
    },
    [localPath, refreshResources, onDeleteResource, onResourceDeleted],
  );

  // Live per-resource control via txAdmin (restart_res / stop_res / start_res).
  // Drives the same REST path as the server Restart button (fivem-studio-myn).
  const controlResource = useCallback(async (name: string, action: ResourceAction) => {
    setControlling({ name, action });
    setControlError(null);
    try {
      const result = await window.api.txadmin.command(`${action}_res`, name);
      if (!result.ok) {
        setControlError({ name, error: result.error ?? `Failed to ${action} ${name}` });
        setTimeout(() => setControlError(null), 5000);
      }
    } finally {
      setControlling(null);
    }
  }, []);

  // Load server resources on mount and when localPath changes
  useEffect(() => {
    refreshResources();
  }, [refreshResources]);

  // Auto-expand the generated resource in file tree. Also re-scan the resource
  // list (a newly written resource isn't in serverResources yet) and drop any
  // stale cached files for it so the freshly written files reload. When the
  // result is cleared (e.g. Checkpoint restore/undo deletes the files), re-scan
  // so the now-gone resource disappears from the tree instead of lingering.
  const prevResultName = useRef<string | null>(null);
  useEffect(() => {
    const name = lastResult?.resourceName ?? null;
    if (name) {
      setExpandedResource(name);
      void refreshResources();
      setResourceFiles((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    } else if (prevResultName.current) {
      const removed = prevResultName.current;
      void refreshResources();
      setResourceFiles((prev) => {
        if (!prev.has(removed)) return prev;
        const next = new Map(prev);
        next.delete(removed);
        return next;
      });
      setExpandedResource((cur) => (cur === removed ? null : cur));
    }
    prevResultName.current = name;
  }, [lastResult, refreshResources]);

  // Load files for expanded resource
  useEffect(() => {
    if (!expandedResource || !localPath) return;
    if (resourceFiles.has(expandedResource)) return;
    let cancelled = false;
    setLoadingFiles(expandedResource);
    const absFolder = `${localPath}/${expandedResource}`;
    window.api
      .listDir(absFolder)
      .then((entries) => {
        if (!cancelled) {
          setResourceFiles((prev) => {
            const next = new Map(prev);
            next.set(expandedResource, entries);
            return next;
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResourceFiles((prev) => {
            const next = new Map(prev);
            next.set(expandedResource, []);
            return next;
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedResource, localPath, resourceFiles]);

  const toggleResource = useCallback((name: string) => {
    setExpandedResource((prev) => (prev === name ? null : name));
    setConfirmDelete(null);
  }, []);

  return {
    serverResources,
    expandedResource,
    resourceFiles,
    loadingResources,
    loadingFiles,
    confirmDelete,
    deleting,
    setConfirmDelete,
    toggleResource,
    refreshResources,
    handleDelete,
    controlling,
    controlError,
    controlResource,
  } satisfies UseFileTreeReturn;
}
