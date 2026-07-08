import { ArrowLeft } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import type { SettingsNewMenuItem, SettingsNewMenuKey } from "../types";

const MENU_ITEMS: SettingsNewMenuItem[] = [
  { key: "general", label: "通用" },
  { key: "modelPool", label: "模型池" },
  {
    key: "agent",
    label: "智能体",
    children: [
      { key: "agentModel", label: "模型" },
      { key: "agentRoute", label: "路由" },
      { key: "agentMemory", label: "记忆" },
      { key: "agentResident", label: "常驻" },
      { key: "agentSearch", label: "搜索" },
      { key: "agentSchedule", label: "定时任务" },
    ],
  },
  { key: "integrations", label: "外部集成" },
  { key: "extensions", label: "拓展" },
  { key: "privacy", label: "安全隐私" },
  { key: "advanced", label: "高级" },
  { key: "about", label: "关于", showDot: true },
];

type SettingsNewSidebarProps = {
  selectedKey: SettingsNewMenuKey;
  onSelect: (key: SettingsNewMenuKey) => void;
  onClose: () => void;
};

const isItemActive = (
  item: SettingsNewMenuItem,
  selectedKey: SettingsNewMenuKey,
): boolean => {
  if (item.key === selectedKey) return true;
  if (!item.children || item.children.length === 0) return false;
  return item.children.some((child) => child.key === selectedKey);
};

export default function SettingsNewSidebar({
  selectedKey,
  onSelect,
  onClose,
}: SettingsNewSidebarProps) {
  return (
    <aside className="w-full shrink-0 border-r border-border bg-muted/20 md:w-[260px]">
      <div className="flex h-full flex-col">
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回应用
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5">
          <ul className="space-y-4">
            {MENU_ITEMS.map((item) => {
              const active = isItemActive(item, selectedKey);
              const hasChildren = Boolean(item.children?.length);
              return (
                <li key={item.key} className="space-y-2">
                  <button
                    type="button"
                    onClick={hasChildren ? undefined : () => onSelect(item.key)}
                    disabled={hasChildren}
                    className={cn(
                      "flex w-full items-center rounded-md px-3 py-1.5 text-left text-[16px] leading-7 tracking-[0.01em]",
                      hasChildren
                        ? "cursor-default"
                        : "cursor-pointer transition-colors hover:bg-muted hover:font-semibold",
                      active
                        ? "font-semibold text-foreground"
                        : "font-medium text-foreground/90",
                    )}
                  >
                    <span>{item.label}</span>
                    {item.showDot ? (
                      <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />
                    ) : null}
                  </button>

                  {item.children && item.children.length > 0 ? (
                    <ul className="space-y-2">
                      {item.children.map((child) => (
                        <li key={child.key}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.key)}
                            className={cn(
                              "flex w-full cursor-pointer items-center rounded-md py-1.5 pl-12 pr-3 text-left text-[16px] leading-7 tracking-[0.01em] transition-colors hover:bg-muted hover:font-semibold",
                              selectedKey === child.key
                                ? "font-semibold text-foreground"
                                : "font-medium text-foreground/90",
                            )}
                          >
                            {child.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
