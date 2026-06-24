import { ColorModeSelector } from "@renderer/components/theme-customizer/color-mode-selector";
import { PresetSelector } from "@renderer/components/theme-customizer/preset-selector";
import { ThemeRadiusSelector } from "@renderer/components/theme-customizer/radius-selector";
import { ThemeScaleSelector } from "@renderer/components/theme-customizer/scale-selector";
import { Separator } from "@renderer/components/ui/separator";
import { SectionHeader } from "./shared";

interface AppearanceSectionProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function AppearanceSection({ isDark, onToggleTheme }: AppearanceSectionProps) {
  return (
    <div className="space-y-0">
      <SectionHeader title="Appearance" />
      <Separator className="mb-1" />

      <div className="py-4 space-y-5">
        <PresetSelector />
        <Separator />
        <ThemeRadiusSelector />
        <ThemeScaleSelector />
        <Separator />
        <ColorModeSelector isDark={isDark} onToggleTheme={onToggleTheme} />
      </div>
    </div>
  );
}
