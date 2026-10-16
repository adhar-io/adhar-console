import React, { useState } from 'react';
import type { ProjectFile } from '../lib/builder-types.ts';
import { fileIcon, fileColor } from '../lib/builder-types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface FileExplorerProps {
  files: ProjectFile[];
  activeFileId: string | null;
  renamingFileId: string | null;
  onOpen: (fileId: string) => void;
  onToggle: (folderId: string) => void;
  onDelete: (fileId: string) => void;
  onRename: (fileId: string, newName: string) => void;
  onStartRename: (fileId: string) => void;
  onNewFile: (folderId: string) => void;
  onNewFolder: (folderId: string) => void;
}

// ─── File Explorer ──────────────────────────────────────────────────────────

export function FileExplorer({
  files,
  activeFileId,
  renamingFileId,
  onOpen,
  onToggle,
  onDelete,
  onRename,
  onStartRename,
  onNewFile,
  onNewFolder,
}: FileExplorerProps) {
  return (
    <div className='py-0.5'>
      {/* Header */}
      <div className='flex items-center justify-between px-2 py-1 mb-0.5'>
        <span className='text-[10px] font-semibold text-muted-foreground uppercase tracking-widest'>
          Explorer
        </span>
        <div className='flex gap-0.5'>
          <button type='button'
            onClick={() => onNewFile('f_src')}
            title='New File'
            className='w-4 h-4 rounded-md flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted'
          >
            +
          </button>
          <button type='button'
            onClick={() => onNewFolder('f_src')}
            title='New Folder'
            className='w-4 h-4 rounded-md flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted'
          >
            +/
          </button>
        </div>
      </div>

      {/* File Tree */}
      {files.map((f) => (
        <FileTreeNode
          key={f.id}
          file={f}
          depth={0}
          activeFileId={activeFileId}
          renamingFileId={renamingFileId}
          onOpen={onOpen}
          onToggle={onToggle}
          onDelete={onDelete}
          onRename={onRename}
          onStartRename={onStartRename}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
        />
      ))}
    </div>
  );
}

// ─── File Tree Node ─────────────────────────────────────────────────────────

function FileTreeNode({
  file,
  depth,
  activeFileId,
  renamingFileId,
  onOpen,
  onToggle,
  onDelete,
  onRename,
  onStartRename,
  onNewFile,
  onNewFolder,
}: {
  file: ProjectFile;
  depth: number;
  activeFileId: string | null;
  renamingFileId: string | null;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onStartRename: (id: string) => void;
  onNewFile: (folderId: string) => void;
  onNewFolder: (folderId: string) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const isActive = file.id === activeFileId;
  const isRenaming = file.id === renamingFileId;
  const isFolder = file.type === 'folder';
  const hasNodes = file.nodes !== undefined;

  function handleClick() {
    if (isFolder) {
      onToggle(file.id);
    } else {
      onOpen(file.id);
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  function handleRenameBlur(e: React.FocusEvent<HTMLInputElement>) {
    onRename(file.id, e.target.value);
  }

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      onRename(file.id, (e.target as HTMLInputElement).value);
    }
    if (e.key === 'Escape') {
      onRename(file.id, file.name);
    }
  }

  return (
    <>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ paddingLeft: depth * 14 + 4 }}
        className={`group flex items-center gap-1 py-[2px] px-1 rounded-md text-[10px] cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          isActive
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-muted-foreground hover:bg-muted/50'
        }`}
      >
        <span className={`text-[10px] w-3 shrink-0 text-center ${fileColor(file)}`}>
          {fileIcon(file)}
        </span>
        {isRenaming ? (
          <input
            autoFocus
            defaultValue={file.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={handleRenameBlur}
            onKeyDown={handleRenameKeyDown}
            className='flex-1 h-4 px-1 text-[10px] bg-background border border-primary/30 rounded-md outline-none'
          />
        ) : (
          <span className='truncate flex-1'>{file.name}</span>
        )}
        {hasNodes && !isFolder && (
          <span className='w-1.5 h-1.5 rounded-full bg-blue-400/40 shrink-0' title='Page' />
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <>
          <div className='fixed inset-0 z-40' onClick={() => setCtxMenu(null)} />
          <div
            className='dropdown fixed w-40'
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={() => setCtxMenu(null)}
          >
            {isFolder && (
              <>
                <button type='button'
                  onClick={() => onNewFile(file.id)}
                  className='dropdown-item'
                >
                  New File
                </button>
                <button type='button'
                  onClick={() => onNewFolder(file.id)}
                  className='dropdown-item'
                >
                  New Folder
                </button>
                <div className='dropdown-separator' />
              </>
            )}
            <button type='button'
              onClick={() => onStartRename(file.id)}
              className='dropdown-item'
            >
              Rename
            </button>
            <button type='button'
              onClick={() => onDelete(file.id)}
              className='dropdown-item text-destructive'
            >
              Delete
            </button>
          </div>
        </>
      )}

      {/* Children */}
      {isFolder && file.expanded && file.children?.map((c) => (
        <FileTreeNode
          key={c.id}
          file={c}
          depth={depth + 1}
          activeFileId={activeFileId}
          renamingFileId={renamingFileId}
          onOpen={onOpen}
          onToggle={onToggle}
          onDelete={onDelete}
          onRename={onRename}
          onStartRename={onStartRename}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
        />
      ))}
    </>
  );
}
