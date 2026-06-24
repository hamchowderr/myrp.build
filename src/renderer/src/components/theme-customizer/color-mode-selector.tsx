import { Label } from "@renderer/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";

interface ColorModeSelectorProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function ColorModeSelector({ isDark, onToggleTheme }: ColorModeSelectorProps) {
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="roundedCorner">Color mode:</Label>
      <ToggleGroup
        className="w-full"
        value={isDark ? "dark" : "light"}
        type="single"
        onValueChange={() => onToggleTheme()}
      >
        <ToggleGroupItem variant="outline" className="grow" value="light">
          Light
        </ToggleGroupItem>
        <ToggleGroupItem variant="outline" className="grow" value="dark">
          Dark
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
