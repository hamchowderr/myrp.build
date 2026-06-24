import { useThemeConfig } from "@renderer/components/active-theme";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { DEFAULT_THEME, THEMES } from "@renderer/lib/themes";

export function PresetSelector() {
  const { theme, setTheme } = useThemeConfig();

  const handlePreset = (value: string) => {
    setTheme({ ...theme, ...DEFAULT_THEME, preset: value });
  };

  return (
    <div className="flex flex-col gap-3">
      <Label>Theme preset:</Label>
      <Select value={theme.preset} onValueChange={(value) => handlePreset(value)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select a theme" />
        </SelectTrigger>
        <SelectContent align="end">
          {THEMES.map((t) => (
            <SelectItem key={t.name} value={t.value}>
              <div className="flex shrink-0 gap-1">
                {t.colors.map((color, key) => (
                  <span
                    key={key}
                    className="size-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
