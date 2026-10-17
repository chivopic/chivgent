import { useEffect, useMemo, useRef, useState, type JSX } from "react";

export type SettingsSection = "general" | "appearance" | "profile" | "about";
export type ThemePreference = "system" | "light" | "dark";
export interface Preferences {
  theme: ThemePreference;
  compact: boolean;
  displayName: string;
  sendOnEnter: boolean;
}

const sections: { id: SettingsSection; title: string; keywords: string }[] = [
  { id: "general", title: "常规", keywords: "general language application 输入 发送 enter 快捷键" },
  { id: "appearance", title: "外观", keywords: "appearance theme dark light compact density 主题 深色 浅色 紧凑" },
  { id: "profile", title: "个人资料", keywords: "profile name avatar 名称 用户 头像" },
  { id: "about", title: "关于", keywords: "about version 版本" },
];

export function readPreferences(): Preferences {
  const fallback: Preferences = { theme: "system", compact: false, displayName: "用户", sendOnEnter: true };
  try {
    const value: unknown = JSON.parse(localStorage.getItem("chivgent.preferences") ?? "null");
    if (typeof value !== "object" || value === null) return fallback;
    const stored = value as Partial<Preferences>;
    return {
      theme: stored.theme === "light" || stored.theme === "dark" ? stored.theme : "system",
      compact: stored.compact === true,
      displayName: typeof stored.displayName === "string" && stored.displayName.trim() ? stored.displayName : "用户",
      sendOnEnter: stored.sendOnEnter !== false,
    };
  } catch {
    return fallback;
  }
}

export function Settings(props: {
  preferences: Preferences;
  onChange: (preferences: Preferences) => void;
  onBack: () => void;
}): JSX.Element {
  const [active, setActive] = useState<SettingsSection>("general");
  const [query, setQuery] = useState("");
  const activeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeButtonRef.current?.focus(); }, []);
  const visibleSections = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return sections;
    return sections.filter((section) => `${section.title} ${section.keywords}`.toLocaleLowerCase().includes(term));
  }, [query]);
  const selected = sections.find((section) => section.id === active) ?? sections[0]!;
  const set = (change: Partial<Preferences>): void => props.onChange({ ...props.preferences, ...change });

  return (
    <div className="settings-screen" data-testid="settings-screen">
      <nav className="settings-rail" aria-label="主导航">
        <button className="rail-home" type="button" aria-label="返回对话" title="返回对话" onClick={props.onBack}>⌂</button>
        <div className="rail-spacer" />
        <button className="rail-avatar" type="button" aria-label="个人资料" onClick={() => setActive("profile")}>{avatarText(props.preferences.displayName)}</button>
      </nav>
      <aside className="settings-nav">
        <div className="settings-nav-heading">
          <button type="button" className="settings-back" onClick={props.onBack} aria-label="返回对话">‹</button>
          <h1>设置</h1>
        </div>
        <label className="settings-search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="搜索设置" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="settings-nav-label">个人</div>
        <div className="settings-section-list" role="navigation" aria-label="设置分类">
          {visibleSections.map((section) => (
            <button key={section.id} ref={active === section.id ? activeButtonRef : undefined} type="button" aria-current={active === section.id ? "page" : undefined} className={`settings-nav-item ${active === section.id ? "selected" : ""}`} onClick={() => setActive(section.id)}>
              <span className="settings-nav-icon" aria-hidden="true">{iconFor(section.id)}</span>{section.title}
            </button>
          ))}
          {visibleSections.length === 0 && <p className="settings-no-results">没有匹配的设置</p>}
        </div>
        <button className="settings-nav-return" type="button" onClick={props.onBack}>返回对话</button>
      </aside>
      <main className="settings-content">
        <div className="settings-content-inner">
          <h2>{selected.title}</h2>
          {active === "general" && <>
            <h3>输入</h3>
            <div className="settings-card">
              <SettingRow title="按 Enter 发送" description="按 Shift+Enter 可在消息中换行。">
                <Toggle label="按 Enter 发送" checked={props.preferences.sendOnEnter} onChange={(sendOnEnter) => set({ sendOnEnter })} />
              </SettingRow>
            </div>
            <p className="settings-note">输入法候选确认不会发送消息。</p>
          </>}
          {active === "appearance" && <>
            <h3>显示</h3>
            <div className="settings-card">
              <SettingRow title="主题" description="选择应用的配色方案。">
                <select aria-label="主题" value={props.preferences.theme} onChange={(event) => set({ theme: event.target.value as ThemePreference })}>
                  <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
                </select>
              </SettingRow>
              <SettingRow title="紧凑布局" description="缩小对话和侧栏中的间距。">
                <Toggle label="紧凑布局" checked={props.preferences.compact} onChange={(compact) => set({ compact })} />
              </SettingRow>
            </div>
          </>}
          {active === "profile" && <>
            <h3>本机资料</h3>
            <div className="settings-card">
              <SettingRow title="显示名称" description="此名称只用于本机界面。">
                <input className="profile-name-input" aria-label="显示名称" maxLength={40} value={props.preferences.displayName} onChange={(event) => set({ displayName: event.target.value })} />
              </SettingRow>
              <SettingRow title="头像" description="使用显示名称的首字作为头像。">
                <span className="profile-preview">{avatarText(props.preferences.displayName)}</span>
              </SettingRow>
            </div>
          </>}
          {active === "about" && <>
            <h3>chivgent 桌面版</h3>
            <div className="settings-card">
              <SettingRow title="应用版本" description="当前桌面应用版本。"><span className="settings-static-value">0.1.0</span></SettingRow>
            </div>
          </>}
        </div>
      </main>
    </div>
  );
}

export function avatarText(name: string): string {
  return Array.from(name.trim())[0] ?? "用";
}

function iconFor(section: SettingsSection): string {
  return section === "general" ? "⚙" : section === "appearance" ? "☼" : section === "profile" ? "◎" : "ⓘ";
}

function SettingRow(props: { title: string; description: string; children: JSX.Element }): JSX.Element {
  return <div className="settings-row"><div className="settings-row-copy"><strong>{props.title}</strong><span>{props.description}</span></div><div className="settings-row-control">{props.children}</div></div>;
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return <button type="button" role="switch" aria-label={props.label} aria-checked={props.checked} className={`settings-toggle ${props.checked ? "on" : ""}`} onClick={() => props.onChange(!props.checked)}><span /></button>;
}
