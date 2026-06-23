'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { AnimateIcon } from '@/components/animate-ui/icons/icon'
import { Trash2 } from '@/components/animate-ui/icons/trash-2'

type AnimatedIcon = React.ComponentType<{ size?: number; className?: string }>

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

interface FileDropProps {
  id: string
  label: string
  hint: string
  accept: string
  multiple?: boolean
  icon: AnimatedIcon
  /** full tailwind class applied to the icon wrapper on hover, e.g. "group-hover:text-blue-500" */
  hoverColor: string
  files: File[]
  onFiles: (files: File[]) => void
}

export function FileDrop({
  id,
  label,
  hint,
  accept,
  multiple = false,
  icon: Icon,
  hoverColor,
  files,
  onFiles,
}: FileDropProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const hasFiles = files.length > 0

  const setNextFiles = (nextFiles: FileList | null) => {
    if (!nextFiles?.length) return
    const selected = Array.from(nextFiles)
    if (multiple) {
      const existingKeys = new Set(files.map((f) => `${f.name}-${f.size}-${f.lastModified}`))
      const uniqueNew = selected.filter((f) => !existingKeys.has(`${f.name}-${f.size}-${f.lastModified}`))
      onFiles([...files, ...uniqueNew])
    } else {
      onFiles(selected.slice(0, 1))
    }
  }

  const removeFile = (fileToRemove: File) => {
    const next = files.filter((f) => f !== fileToRemove)
    onFiles(next)
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor={id}
          className="text-sm font-medium text-foreground"
        >
          {label}
        </label>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            setNextFiles(e.dataTransfer.files)
          }}
          className={cn(
            'group flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-3.5 text-left transition-all hover:border-foreground/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            hasFiles && 'pr-12',
            dragging && 'border-foreground/60 bg-muted/60',
            hasFiles && 'border-solid border-emerald-500/70 bg-emerald-500/5 hover:border-emerald-500',
          )}
        >
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors',
              hasFiles && 'text-emerald-500',
              hoverColor,
            )}
          >
            <AnimateIcon animate={hovered}>
              <Icon size={20} />
            </AnimateIcon>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {hasFiles
                ? multiple
                  ? `Add more ${label.toLowerCase()}...`
                  : files.map((file) => file.name).join(', ')
                : hint}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {hasFiles
                ? multiple
                  ? `${files.length} selected (${formatSize(files.reduce((acc, f) => acc + f.size, 0))} total)`
                  : files.map((file) => formatSize(file.size)).join(' + ')
                : `${multiple ? 'Accepts multiple' : 'Accepts'} ${accept}`}
            </span>
          </span>
        </button>

        {hasFiles && (
          <AnimateIcon animateOnHover asChild>
            <button
              type="button"
              onClick={() => {
                onFiles([])
                if (inputRef.current) inputRef.current.value = ''
              }}
              aria-label={`Remove ${label}`}
              title={`Remove ${label}`}
              className="absolute right-3 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 size={16} />
            </button>
          </AnimateIcon>
        )}
      </div>

      {multiple && hasFiles && (
        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto mt-0.5">
          {files.map((file, idx) => (
            <div
              key={`${file.name}-${file.size}-${idx}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Icon size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium text-foreground/90" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  ({formatSize(file.size)})
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeFile(file)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title="Remove file"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => setNextFiles(e.target.files)}
      />
    </div>
  )
}
