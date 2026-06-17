import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AnimateIcon } from "@/components/animate-ui/icons/icon";
import { BadgeCheck } from "@/components/animate-ui/icons/badge-check";
import { Blocks } from "@/components/animate-ui/icons/blocks";
import { CircleCheckBig } from "@/components/animate-ui/icons/circle-check-big";
import { Download } from "@/components/animate-ui/icons/download";
import { Fingerprint } from "@/components/animate-ui/icons/fingerprint";
import { Key } from "@/components/animate-ui/icons/key";
import { Layers } from "@/components/animate-ui/icons/layers";
import { LoaderCircle } from "@/components/animate-ui/icons/loader-circle";
import { Lock } from "@/components/animate-ui/icons/lock";
import { LockKeyhole } from "@/components/animate-ui/icons/lock-keyhole";
import { Moon } from "@/components/animate-ui/icons/moon";
import { Send } from "@/components/animate-ui/icons/send";
import { Sun } from "@/components/animate-ui/icons/sun";
import { Terminal } from "@/components/animate-ui/icons/terminal";
import { Trash2 } from "@/components/animate-ui/icons/trash-2";
import { saveOutput, signIpa } from "./zsign-api";
import type { OutputFile, SignIpaOptions } from "./types";

type StatusTone = "idle" | "busy" | "ok" | "error";
type Route = "app" | "privacy" | "legal";
type FileKind = "ipa" | "p12" | "profiles" | "dylibs";

type CachedFileData = {
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
};

type CachedCertInfo = {
  p12?: CachedFileData;
  profiles: CachedFileData[];
  password?: string;
  savedAt: number;
};

const certCacheDbName = "zsign-wasm-cert-cache";
const certCacheStore = "cert-info";
const certCacheKey = "default";

const fileConfig = {
  ipa: {
    label: "IPA file",
    hint: "Select or drop the .ipa you want to sign",
    accept: ".ipa,.zip",
    multiple: false,
    Icon: Layers,
    accent: "blue"
  },
  p12: {
    label: "Signing certificate",
    hint: "Select or drop your .p12 or .pfx",
    accept: ".p12,.pfx",
    multiple: false,
    Icon: BadgeCheck,
    accent: "emerald"
  },
  profiles: {
    label: "Provisioning profiles",
    hint: "Select one or more .mobileprovision files",
    accept: ".mobileprovision,.provisionprofile",
    multiple: true,
    Icon: LockKeyhole,
    accent: "amber"
  },
  dylibs: {
    label: "Dylibs",
    hint: "Optional .dylib files to inject",
    accept: ".dylib",
    multiple: true,
    Icon: Blocks,
    accent: "rose"
  }
} satisfies Record<
  FileKind,
  {
    label: string;
    hint: string;
    accept: string;
    multiple: boolean;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    accent: string;
  }
>;

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      focusable="false"
    >
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.21.09 1.85 1.25 1.85 1.25 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.47 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

function openCertCacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(certCacheDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(certCacheStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open cert cache."));
  });
}

async function withCertCacheStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
) {
  const db = await openCertCacheDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(certCacheStore, mode);
      const request = callback(transaction.objectStore(certCacheStore));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Cert cache request failed."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Cert cache transaction failed."));
    });
  } finally {
    db.close();
  }
}

async function readCachedCertInfo() {
  return (await withCertCacheStore("readonly", (store) => store.get(certCacheKey))) as CachedCertInfo | null;
}

async function writeCachedCertInfo(value: CachedCertInfo) {
  await withCertCacheStore("readwrite", (store) => store.put(value, certCacheKey));
}

async function deleteCachedCertInfo() {
  await withCertCacheStore("readwrite", (store) => store.delete(certCacheKey));
}

async function fileToCachedData(nextFile: File): Promise<CachedFileData> {
  return {
    name: nextFile.name,
    type: nextFile.type,
    lastModified: nextFile.lastModified,
    data: await nextFile.arrayBuffer()
  };
}

function cachedDataToFile(nextFile: CachedFileData) {
  return new File([nextFile.data], nextFile.name, {
    type: nextFile.type,
    lastModified: nextFile.lastModified
  });
}

function defaultOutputName(ipa?: File | null) {
  if (!ipa) return "signed.ipa";
  const base = ipa.name.replace(/\.(ipa|zip)$/i, "");
  return `${base || "app"}_signed.ipa`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function cleanLogLine(line: string) {
  return line.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function routeFromHash(): Route {
  if (location.hash === "#privacy") return "privacy";
  if (location.hash === "#legal") return "legal";
  return "app";
}

function useHashRoute() {
  const [route, setRoute] = React.useState<Route>(routeFromHash);
  React.useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

function ThemeToggle() {
  const [dark, setDark] = React.useState(() => {
    const saved = localStorage.getItem("sylva-theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("sylva-theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <AnimateIcon animateOnHover asChild>
      <button className="icon-button" type="button" onClick={() => setDark((next) => !next)} title="Toggle theme">
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    </AnimateIcon>
  );
}

function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <div className="status-pill" data-tone={tone}>
      <span className="status-dot" />
      {label}
    </div>
  );
}

function FileDrop({
  kind,
  files,
  onFiles
}: {
  kind: FileKind;
  files: File[];
  onFiles: (files: File[]) => void;
}) {
  const config = fileConfig[kind];
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const hasFiles = files.length > 0;

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming?.length) return;
    const next = Array.from(incoming);
    onFiles(config.multiple ? next : next.slice(0, 1));
  };

  return (
    <div className="file-field">
      <div className="field-topline">
        <label htmlFor={kind}>{config.label}</label>
        {hasFiles ? (
          <AnimateIcon animateOnHover asChild>
            <button
              className="remove-file"
              type="button"
              onClick={() => {
                onFiles([]);
                if (inputRef.current) inputRef.current.value = "";
              }}
              title={`Clear ${config.label}`}
            >
              <Trash2 size={17} />
              <span className="sr-only">Clear {config.label}</span>
            </button>
          </AnimateIcon>
        ) : null}
      </div>
      <button
        className="file-drop"
        data-accent={config.accent}
        data-active={hasFiles}
        data-dragging={dragging}
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <span className="file-icon">
          <AnimateIcon animateOnHover>
            <config.Icon size={21} />
          </AnimateIcon>
        </span>
        <span className="file-copy">
          <span>{hasFiles ? files.map((file) => file.name).join(", ") : config.hint}</span>
          <small>
            {hasFiles
              ? files.map((file) => formatBytes(file.size)).join(" + ")
              : `${config.multiple ? "Accepts multiple" : "Accepts"} ${config.accept}`}
          </small>
        </span>
      </button>
      <input
        ref={inputRef}
        id={kind}
        type="file"
        accept={config.accept}
        multiple={config.multiple}
        onChange={(event) => acceptFiles(event.target.files)}
      />
    </div>
  );
}

function LogConsole({ logs }: { logs: string[] }) {
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  return (
    <section className="console-panel">
      <div className="console-head">
        <AnimateIcon animateOnHover>
          <Terminal size={16} />
        </AnimateIcon>
        <span>Live logs</span>
        <code>{logs.length} {logs.length === 1 ? "line" : "lines"}</code>
      </div>
      <div className="console-body" id="logs">
        {logs.length === 0 ? (
          <p className="empty-log">&gt; Waiting for files. Signing output will stream here.</p>
        ) : (
          logs.map((line, index) => (
            <div className="log-line" key={`${index}-${line}`}>
              <span>{String(index + 1).padStart(3, "0")}</span>
              <p>{cleanLogLine(line)}</p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <nav>
        <a href="#privacy">Privacy Policy</a>
        <a href="#legal">Legal</a>
        <a href="https://github.com/AntonP29" target="_blank" rel="noreferrer">
          <GithubIcon size={15} />
          AntonP29
        </a>
      </nav>
    </footer>
  );
}

function AppHeader({ status, tone }: { status: string; tone: StatusTone }) {
  return (
    <header className="app-header">
      <a className="brand" href="#" aria-label="Sylva Signer home">
        <span className="logo-frame">
          <img className="logo-light" src="/icon-light.png" alt="" />
          <img className="logo-dark" src="/icon-dark.png" alt="" />
        </span>
        <span>
          <strong>Sylva Signer</strong>
          <small>Fully local IPA signing in your browser</small>
        </span>
      </a>
      <div className="header-actions">
        <StatusPill label={status} tone={tone} />
        <ThemeToggle />
      </div>
    </header>
  );
}

function Outputs({ outputs, onDownload }: { outputs: OutputFile[]; onDownload: (output: OutputFile) => void }) {
  return (
    <section className="outputs-panel">
      <div className="section-title">
        <AnimateIcon animateOnHover>
          <Download size={17} />
        </AnimateIcon>
        <span>Signed output</span>
      </div>
      {outputs.length === 0 ? (
        <p className="muted">Completed IPA files will appear here for local download.</p>
      ) : (
        <div className="output-list" id="outputs">
          {outputs.map((output, index) => (
            <div className="output-row" key={`${output.path}-${index}`}>
              <div>
                <strong>{output.name}</strong>
                <small>{formatBytes(output.data.byteLength)}</small>
              </div>
              <AnimateIcon animateOnHover asChild>
                <button type="button" onClick={() => onDownload(output)} title={`Download ${output.name}`}>
                  <Download size={17} />
                  Download
                </button>
              </AnimateIcon>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SignerPage({
  onStatusChange
}: {
  onStatusChange: (status: string, tone: StatusTone) => void;
}) {
  const [ipa, setIpa] = React.useState<File[]>([]);
  const [p12, setP12] = React.useState<File[]>([]);
  const [profiles, setProfiles] = React.useState<File[]>([]);
  const [dylibs, setDylibs] = React.useState<File[]>([]);
  const [password, setPassword] = React.useState("");
  const [outputName, setOutputName] = React.useState("signed.ipa");
  const [bundleId, setBundleId] = React.useState("");
  const [cacheCert, setCacheCert] = React.useState(false);
  const [cachedCertInfo, setCachedCertInfo] = React.useState<CachedCertInfo | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [outputs, setOutputs] = React.useState<OutputFile[]>([]);
  const [status, setStatus] = React.useState("Idle");
  const [tone, setTone] = React.useState<StatusTone>("idle");
  const [outputNameTouched, setOutputNameTouched] = React.useState(false);
  const signing = tone === "busy";

  React.useEffect(() => {
    onStatusChange(status, tone);
  }, [onStatusChange, status, tone]);

  React.useEffect(() => {
    readCachedCertInfo()
      .then((cache) => {
        setCachedCertInfo(cache);
        if (cache?.password) setPassword(cache.password);
        if (cache?.p12 || cache?.profiles.length || cache?.password) setCacheCert(true);
      })
      .catch(() => setCachedCertInfo(null));
  }, []);

  React.useEffect(() => {
    if (!outputNameTouched) setOutputName(defaultOutputName(ipa[0]));
  }, [ipa, outputNameTouched]);

  const appendLog = React.useCallback((line: string) => {
    setLogs((current) => [...current, line]);
  }, []);

  const saveCertCacheFromInputs = async () => {
    const next: CachedCertInfo = {
      p12: p12[0] ? await fileToCachedData(p12[0]) : cachedCertInfo?.p12,
      profiles: profiles.length ? await Promise.all(profiles.map(fileToCachedData)) : cachedCertInfo?.profiles ?? [],
      password: password || cachedCertInfo?.password,
      savedAt: Date.now()
    };
    if (!next.p12 && next.profiles.length === 0 && !next.password) return;
    await writeCachedCertInfo(next);
    setCachedCertInfo(next);
  };

  const clearCache = async () => {
    await deleteCachedCertInfo();
    setCachedCertInfo(null);
    setCacheCert(false);
    setStatus("Cache cleared");
    setTone("ok");
  };

  const clearForm = () => {
    setIpa([]);
    setP12([]);
    setProfiles([]);
    setDylibs([]);
    setBundleId("");
    setOutputs([]);
    setLogs([]);
    setOutputNameTouched(false);
    setOutputName("signed.ipa");
    if (!cacheCert) setPassword("");
    setStatus("Idle");
    setTone("idle");
  };

  const buildOptions = (): SignIpaOptions => {
    const currentIpa = ipa[0];
    if (!currentIpa) throw new Error("Choose an IPA before signing.");
    const cachedP12 = cachedCertInfo?.p12 ? cachedDataToFile(cachedCertInfo.p12) : undefined;
    const cachedProfiles = cachedCertInfo?.profiles.map(cachedDataToFile) ?? [];
    const selectedP12 = p12[0] ?? (cacheCert ? cachedP12 : undefined);
    const selectedProfiles = profiles.length > 0 ? profiles : cacheCert ? cachedProfiles : [];

    if (!selectedP12) throw new Error("Choose a P12/PFX signing certificate.");
    if (selectedProfiles.length === 0) throw new Error("Choose at least one provisioning profile.");

    return {
      ipa: currentIpa,
      p12: selectedP12,
      profiles: selectedProfiles,
      dylibs,
      password: password || (cacheCert ? cachedCertInfo?.password ?? "" : ""),
      outputName: outputName || defaultOutputName(currentIpa),
      bundleId,
      zipLevel: 0,
      metadata: false
    };
  };

  const sign = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus("Signing");
    setTone("busy");
    setLogs([]);
    setOutputs([]);

    try {
      if (cacheCert) await saveCertCacheFromInputs();
      appendLog(">>> Starting local browser signing session");
      const result = await signIpa(buildOptions(), { onLog: appendLog });
      setOutputs(result.outputs);
      appendLog(`>>> zsign exited with code ${result.exitCode}`);
      setStatus(result.exitCode === 0 ? "Signed" : "Failed");
      setTone(result.exitCode === 0 ? "ok" : "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(`>>> ${message}`);
      setStatus("Error");
      setTone("error");
    }
  };

  const hasCache = Boolean(cachedCertInfo?.p12 || cachedCertInfo?.profiles.length || cachedCertInfo?.password);

  return (
    <>
      <section className="hero-copy">
        <div>
          <span className="eyebrow">Private by design</span>
          <h1>Sign IPA files fully locally in your browser.</h1>
        </div>
        <p>
          Sylva Signer runs zsign as WebAssembly inside a dedicated browser worker. Your IPA, certificate,
          provisioning profile, password, and signed output remain on this device.
        </p>
      </section>

      <main className="workspace">
        <form className="sign-card" onSubmit={sign}>
          <section className="card-section">
            <div className="section-title">
              <AnimateIcon animateOnHover>
                <Layers size={17} />
              </AnimateIcon>
              <span>Signing inputs</span>
            </div>
            <FileDrop kind="ipa" files={ipa} onFiles={setIpa} />
            <FileDrop kind="p12" files={p12} onFiles={setP12} />
            <FileDrop kind="profiles" files={profiles} onFiles={setProfiles} />
            <FileDrop kind="dylibs" files={dylibs} onFiles={setDylibs} />
          </section>

          <section className="card-section">
            <div className="section-title">
              <AnimateIcon animateOnHover>
                <Key size={17} />
              </AnimateIcon>
              <span>Credentials and options</span>
            </div>
            <label className="text-field">
              <span>Certificate password</span>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter the P12 password"
                autoComplete="off"
              />
            </label>
            <div className="field-grid">
              <label className="text-field">
                <span>Output IPA name</span>
                <input
                  id="output-name"
                  type="text"
                  value={outputName}
                  onChange={(event) => {
                    setOutputNameTouched(true);
                    setOutputName(event.target.value);
                  }}
                  placeholder="Example_signed.ipa"
                />
              </label>
              <label className="text-field">
                <span>Bundle ID</span>
                <input
                  id="bundle-id"
                  type="text"
                  value={bundleId}
                  onChange={(event) => setBundleId(event.target.value)}
                  placeholder="Leave blank to keep original"
                />
              </label>
            </div>
            <div className="cache-panel">
              <label>
                <AnimateIcon animateOnHover>
                  <Fingerprint size={20} />
                </AnimateIcon>
                <span>
                  <strong>Cache certificate info locally</strong>
                  <small>Stores selected certificate data and password in this browser's IndexedDB.</small>
                </span>
                <input
                  id="cache-cert-info"
                  type="checkbox"
                  checked={cacheCert}
                  onChange={(event) => setCacheCert(event.target.checked)}
                />
              </label>
              {hasCache ? (
                <AnimateIcon animateOnHover asChild>
                  <button className="ghost-button danger" id="clear-cert-cache" type="button" onClick={clearCache}>
                    <Trash2 size={16} />
                    Forget cached cert
                  </button>
                </AnimateIcon>
              ) : null}
            </div>
          </section>

          <div className="action-row">
            <AnimateIcon animate={signing} loop={signing} animateOnHover asChild>
              <button id="sign-button" className="primary-button" type="submit" disabled={signing}>
                {signing ? <LoaderCircle size={18} animate loop /> : <Send size={18} />}
                {signing ? "Signing..." : "Sign IPA"}
              </button>
            </AnimateIcon>
            <AnimateIcon animateOnHover asChild>
              <button className="ghost-button" id="clear-form" type="button" onClick={clearForm}>
                <Trash2 size={16} />
                Clear
              </button>
            </AnimateIcon>
          </div>
        </form>

        <aside className="side-stack">
          <LogConsole logs={logs} />
          {tone === "ok" && outputs.length > 0 ? (
            <div className="success-callout">
              <CircleCheckBig size={20} animate />
              <span>
                <strong>Signing complete</strong>
                <small>Your signed IPA is ready for local download.</small>
              </span>
            </div>
          ) : null}
          <Outputs outputs={outputs} onDownload={saveOutput} />
        </aside>
      </main>
    </>
  );
}

function InfoPage({ route }: { route: Exclude<Route, "app"> }) {
  const isPrivacy = route === "privacy";
  return (
    <main className="info-page">
      <a className="back-link" href="#">
        Back to signer
      </a>
      <section className="info-card">
        <div className="info-title">
          <AnimateIcon animateOnHover>
            {isPrivacy ? <Lock size={28} /> : <BadgeCheck size={28} />}
          </AnimateIcon>
          <div>
            <span className="eyebrow">{isPrivacy ? "Privacy Policy" : "Legal"}</span>
            <h1>{isPrivacy ? "Privacy Policy" : "Legal Notice"}</h1>
          </div>
        </div>
        {isPrivacy ? (
          <>
            <p>
              Sylva Signer is designed to process IPA signing inputs locally in your browser. The application does
              not require a signing server and does not intentionally upload IPA files, signing certificates,
              provisioning profiles, passwords, or signed outputs.
            </p>
            <p>
              Optional certificate caching stores selected signing material and password data in the browser's
              local IndexedDB storage on this device. You can clear that cache from the signer interface at any time.
            </p>
            <p>
              If you use a hosted copy of this project, your browser still downloads the application code from that
              host. Only use builds and domains you trust.
            </p>
          </>
        ) : (
          <>
            <p>
              Sylva Signer is provided as a local browser tool for lawful IPA signing workflows using certificates,
              provisioning profiles, and applications you are authorized to use.
            </p>
            <p>
              You are responsible for complying with Apple developer terms, app distribution rules, software
              licenses, and all applicable laws. The project does not provide Apple certificates, provisioning
              profiles, app entitlements, or third-party app assets.
            </p>
            <p>
              This project is made by AntonP29. Source and updates are available on GitHub.
            </p>
          </>
        )}
        <a className="github-link" href="https://github.com/AntonP29" target="_blank" rel="noreferrer">
          <GithubIcon size={18} />
          Visit AntonP29 on GitHub
        </a>
      </section>
    </main>
  );
}

function Root() {
  const route = useHashRoute();
  const [status, setStatus] = React.useState("Idle");
  const [tone, setTone] = React.useState<StatusTone>("idle");
  const handleStatusChange = React.useCallback((nextStatus: string, nextTone: StatusTone) => {
    setStatus(nextStatus);
    setTone(nextTone);
  }, []);

  return (
    <div className="app-shell">
      <AppHeader status={route === "app" ? status : "Info"} tone={route === "app" ? tone : "idle"} />
      {route === "app" ? (
        <SignerPage onStatusChange={handleStatusChange} />
      ) : (
        <InfoPage route={route} />
      )}
      <Footer />
    </div>
  );
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root");

createRoot(root).render(<Root />);
