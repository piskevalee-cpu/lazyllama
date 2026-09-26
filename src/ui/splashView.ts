import { BoxRenderable, type CliRenderer } from "@opentui/core";
import { staticText } from "./components.js";
import { DARK_THEME, type UiTheme } from "./theme.js";
import type { SplashFrame } from "../splash.js";

export class SplashView {
  readonly body: BoxRenderable;
  private readonly logo;
  private readonly status;

  constructor(
    renderer: CliRenderer,
    theme: UiTheme = DARK_THEME,
  ) {
    this.body = new BoxRenderable(renderer, {
      id: "splash",
      flexDirection: "column",
      flexGrow: 1,
      justifyContent: "center",
      alignItems: "center",
    });
    this.logo = staticText(renderer, {
      id: "splash-logo",
      width: "100%",
      textAlign: "center",
      wrapMode: "none",
    });
    this.logo.fg = theme.text;
    this.status = staticText(renderer, {
      id: "splash-status",
      width: "100%",
      textAlign: "center",
      wrapMode: "none",
    });
    this.status.fg = theme.muted;
    this.body.add(this.logo);
    this.body.add(this.status);
  }

  render(frame: SplashFrame): void {
    this.logo.content = frame.styledLogo;
    this.status.content = `${frame.status}  loading lazyllama`;
  }

  setVisible(visible: boolean): void {
    this.body.visible = visible;
  }
}
