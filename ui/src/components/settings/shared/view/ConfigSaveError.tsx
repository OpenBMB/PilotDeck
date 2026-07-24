type ConfigSaveErrorProps = {
  error?: string | null;
};

export default function ConfigSaveError({ error }: ConfigSaveErrorProps) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      {error}
    </div>
  );
}
