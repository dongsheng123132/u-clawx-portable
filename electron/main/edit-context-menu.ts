import { Menu, type WebContents } from 'electron';

/**
 * 输入框右键菜单（剪切 / 复制 / 粘贴 / 全选）。
 *
 * 为什么需要：Electron 里输入框的 Ctrl+V 靠应用菜单的 `role: 'paste'`
 * 加速键生效，但**右键什么都不弹**——而对普通用户来说，往输入框里粘一段
 * 密钥的本能动作就是右键。没有这个菜单，用户会以为「粘贴不上、功能坏了」。
 *
 * 只在可编辑区域弹；选中文本时额外给「复制」。走 Electron 的 role，
 * 不自己碰剪贴板内容，也就不需要新增 IPC 面。
 */
export function installEditContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, props) => {
    const { isEditable, editFlags, selectionText } = props;
    const hasSelection = Boolean(selectionText?.trim());

    if (!isEditable && !hasSelection) return;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (isEditable) {
      template.push(
        { role: 'cut', label: '剪切', enabled: editFlags.canCut },
        { role: 'copy', label: '复制', enabled: editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      );
    } else {
      template.push({ role: 'copy', label: '复制', enabled: editFlags.canCopy });
    }

    Menu.buildFromTemplate(template).popup({ window: undefined });
  });
}
