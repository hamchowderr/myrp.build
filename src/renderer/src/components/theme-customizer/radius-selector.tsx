import { useThemeConfig } from "@renderer/components/active-theme";
import { Label } from "@renderer/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { BanIcon } from "lucide-react";

export function ThemeRadiusSelector() {
  const { theme, setTheme } = useThemeConfig();

  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="roundedCorner">Radius:</Label>
      <ToggleGroup
        className="w-full"
        value={theme.radius}
        type="single"
        onValueChange={(value) => setTheme({ ...theme, radius: value })}
      >
        <ToggleGroupItem variant="outline" className="grow" value="none">
          <BanIcon />
        </ToggleGroupItem>
        <ToggleGroupItem variant="outline" className="grow" value="sm">
          SM
        </ToggleGroupItem>
        <ToggleGroupItem variant="outline" className="grow" value="md">
          MD
        </ToggleGroupItem>
        <ToggleGroupItem variant="outline" className="grow" value="lg">
          LG
        </ToggleGroupItem>
        <ToggleGroupItem variant="outline" className="grow" value="xl">
          XL
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
