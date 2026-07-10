import { Select } from "../../modelPool/components/Inputs";

type ModelRefInputProps = {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
};

export default function ModelRefInput({
  value,
  onChange,
  options,
  placeholder,
}: ModelRefInputProps) {
  const selected = value ?? "";
  const hasSelected = !selected || options.some((opt) => opt.value === selected);
  const selectOptions = [
    { value: "", label: placeholder ?? "Select a configured model" },
    ...options,
    ...(!hasSelected ? [{ value: selected, label: `Missing: ${selected}` }] : []),
  ];
  return <Select value={selected} onChange={onChange} options={selectOptions} />;
}
