export default function CapabilityScopeLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载员工能力"
      className="min-h-full box-border animate-pulse px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]"
    >
      <div className="h-[20px] w-[112px] rounded-[7px] bg-[#eef1f6]" />
      <div className="mt-[12px] h-[14px] w-[280px] max-w-[70%] rounded-[6px] bg-[#f4f6f9]" />
      <div className="mt-[44px] grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-[72px] rounded-[16px] bg-[#f4f5f7]" />
        ))}
      </div>
      <div className="mt-[20px] h-[360px] rounded-[20px] bg-white shadow-[0_0_6px_rgba(0,0,0,0.05)]">
        <div className="h-[52px] rounded-t-[20px] bg-[#f5f6f9]" />
      </div>
      <span className="sr-only">正在加载当前员工的能力配置…</span>
    </div>
  );
}

