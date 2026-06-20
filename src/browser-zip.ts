import { BlobReader, BlobWriter, ZipReader, ZipWriter, type FileEntry } from "@zip.js/zip.js";

type ZipProgress = (completed: number, total: number) => void;

type ArchiveFile = {
  path: string;
  handle: FileSystemFileHandle;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function extractionConcurrency() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memoryLimit = memory !== undefined && memory <= 4 ? 2 : 4;
  const cpuLimit = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2));
  return Math.min(memoryLimit, cpuLimit);
}

async function parallelFor<T>(items: T[], action: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(extractionConcurrency(), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await action(item);
    }
  });
  await Promise.all(workers);
}

function safeZipPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("/") || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe IPA entry path: ${path}`);
  }
  return parts;
}

async function ensureDirectory(root: FileSystemDirectoryHandle, parts: string[]) {
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

export async function extractIpaToOpfs(
  ipa: Blob,
  destination: FileSystemDirectoryHandle,
  onProgress?: ZipProgress
) {
  const reader = new ZipReader(new BlobReader(ipa), {
    useCompressionStream: true,
    useWebWorkers: false
  });

  try {
    const entries = await reader.getEntries();
    const total = entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.uncompressedSize), 0);
    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
    const reserve = Math.max(ipa.size * 2, 64 * 1024 * 1024);
    if (available > 0 && total + reserve > available) {
      throw new Error("Not enough browser storage is available to extract and sign this IPA.");
    }

    let completed = 0;
    onProgress?.(completed, total);
    await parallelFor(entries, async (entry) => {
      const parts = safeZipPath(entry.filename);
      if (!parts.length) return;
      if (entry.directory) {
        await ensureDirectory(destination, parts);
        return;
      }

      const parent = await ensureDirectory(destination, parts.slice(0, -1));
      const fileHandle = await parent.getFileHandle(parts.at(-1)!, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await (entry as FileEntry).getData(writable, {
          useCompressionStream: true,
          useWebWorkers: false
        });
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
      completed += entry.uncompressedSize;
      onProgress?.(completed, total);
    });
    return { entries: entries.length, uncompressedSize: total };
  } finally {
    await reader.close();
  }
}

function ensureMemfsDirectory(FS: any, path: string) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch (error: any) {
      if (error?.errno !== 20) throw error;
    }
  }
}

export async function extractIpaToMemfs(
  ipa: Blob,
  FS: any,
  destination: string,
  onProgress?: ZipProgress
) {
  const reader = new ZipReader(new BlobReader(ipa), {
    useCompressionStream: true,
    useWebWorkers: false
  });
  try {
    const entries = await reader.getEntries();
    const total = entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.uncompressedSize), 0);
    let completed = 0;
    ensureMemfsDirectory(FS, destination);
    onProgress?.(completed, total);

    await parallelFor(entries, async (entry) => {
      const parts = safeZipPath(entry.filename);
      if (!parts.length) return;
      const path = `${destination.replace(/\/$/, "")}/${parts.join("/")}`;
      if (entry.directory) {
        ensureMemfsDirectory(FS, path);
        return;
      }
      ensureMemfsDirectory(FS, path.slice(0, path.lastIndexOf("/")));
      const stream = FS.open(path, "w");
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          FS.close(stream);
        }
      };
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          FS.write(stream, chunk, 0, chunk.byteLength);
        },
        close,
        abort: close
      });
      await (entry as FileEntry).getData(writable, {
        useCompressionStream: true,
        useWebWorkers: false
      });
      completed += entry.uncompressedSize;
      onProgress?.(completed, total);
    });
    return { entries: entries.length, uncompressedSize: total };
  } finally {
    await reader.close();
  }
}

function collectMemfsFiles(FS: any, directory: string, prefix: string, files: string[]) {
  for (const name of FS.readdir(directory)) {
    if (name === "." || name === "..") continue;
    const path = `${directory.replace(/\/$/, "")}/${name}`;
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = FS.stat(path);
    if (FS.isDir(stat.mode)) collectMemfsFiles(FS, path, relative, files);
    else if (FS.isFile(stat.mode)) files.push(relative);
  }
}

function memfsReadable(FS: any, path: string, size: number) {
  const stream = FS.open(path, "r");
  let offset = 0;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      FS.close(stream);
    }
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= size) {
        close();
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(1024 * 1024, size - offset));
      const read = FS.read(stream, chunk, 0, chunk.byteLength, offset);
      offset += read;
      controller.enqueue(read === chunk.byteLength ? chunk : chunk.subarray(0, read));
    },
    cancel: close
  });
}

export async function archiveMemfsToIpa(
  FS: any,
  source: string,
  level: number,
  onProgress?: ZipProgress
) {
  const files: string[] = [];
  collectMemfsFiles(FS, source, "", files);
  files.sort((left, right) => left.localeCompare(right));
  const sizes = files.map((path) => FS.stat(`${source.replace(/\/$/, "")}/${path}`).size as number);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const output = new BlobWriter("application/zip");
  const writer = new ZipWriter(output, {
    level,
    useCompressionStream: true,
    useWebWorkers: false,
    extendedTimestamp: false
  });

  let completed = 0;
  onProgress?.(completed, total);
  for (let index = 0; index < files.length; index++) {
    const path = files[index];
    const size = sizes[index];
    await writer.add(path, memfsReadable(FS, `${source.replace(/\/$/, "")}/${path}`, size), {
      level,
      useCompressionStream: true,
      useWebWorkers: false
    });
    completed += size;
    onProgress?.(completed, total);
  }
  await writer.close();
  return output.getData();
}

async function collectFiles(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  files: ArchiveFile[]
) {
  for await (const [name, handle] of (directory as IterableDirectoryHandle).entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await collectFiles(handle as FileSystemDirectoryHandle, path, files);
    } else {
      files.push({ path, handle: handle as FileSystemFileHandle });
    }
  }
}

export async function archiveOpfsToIpa(
  source: FileSystemDirectoryHandle,
  output: FileSystemFileHandle,
  level: number,
  onProgress?: ZipProgress
) {
  const files: ArchiveFile[] = [];
  await collectFiles(source, "", files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const total = (
    await Promise.all(files.map(async (entry) => (await entry.handle.getFile()).size))
  ).reduce((sum, size) => sum + size, 0);

  const writable = await output.createWritable();
  const writer = new ZipWriter(writable, {
    level,
    useCompressionStream: true,
    useWebWorkers: false,
    extendedTimestamp: false
  });

  let completed = 0;
  onProgress?.(completed, total);
  try {
    for (const entry of files) {
      const file = await entry.handle.getFile();
      await writer.add(entry.path, new BlobReader(file), {
        level,
        lastModDate: file.lastModified ? new Date(file.lastModified) : new Date(),
        useCompressionStream: true,
        useWebWorkers: false
      });
      completed += file.size;
      onProgress?.(completed, total);
    }
    await writer.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }

  return output.getFile();
}
