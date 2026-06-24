import { useThemeConfig } from "@renderer/components/active-theme";
import { Button } from "@renderer/components/ui/button";
import { DEFAULT_THEME } from "@renderer/lib/themes";

export function ResetThemeButton() {
  const { setTheme } = useThemeConfig();

  const resetThemeHandle = () => {
    setTheme(DEFAULT_THEME);
  };

  return (
    <Button className="mt-4 w-full" onClick={resetThemeHandle}>
      Reset to Default
    </Button>
  );
}
