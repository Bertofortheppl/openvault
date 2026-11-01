import { App, PluginSettingTab, Setting, type Plugin } from 'obsidian';
import type { OpenVaultSettings } from './types';

export interface SettingsHost {
  settings: OpenVaultSettings;
  saveSettings(): Promise<void>;
  connect(): Promise<void>;
}

export class OpenVaultSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host as unknown as Plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('opencode binary')
      .setDesc('Absolute path to opencode. Leave empty to auto-detect.')
      .addText((text) =>
        text
          .setPlaceholder('/home/berto/.opencode/bin/opencode')
          .setValue(this.host.settings.opencodePath)
          .onChange(async (value) => {
            this.host.settings.opencodePath = value.trim();
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto-start server')
      .setDesc('Start a managed opencode server when this vault loads.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.autoStart)
          .onChange(async (value) => {
            this.host.settings.autoStart = value;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Inject note context')
      .setDesc('Send the active note path and selection with each prompt.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.injectContext)
          .onChange(async (value) => {
            this.host.settings.injectContext = value;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('The server uses an ephemeral local port. Credentials come from opencode auth.')
      .addButton((button) =>
        button.setButtonText('Reconnect').onClick(() => void this.host.connect()),
      );
  }
}
