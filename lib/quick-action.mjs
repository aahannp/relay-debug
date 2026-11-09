// Finder's right-click "Quick Actions > Open in Relay": an Automator workflow in ~/Library/Services that runs
// `open -b <Relay's bundle id> <folders>`, which reaches the app as open-file (see electron/main.mjs).
// Electron can't provide macOS Services itself, and a top-level menu item would need a signed Finder Sync extension.
import fs from 'node:fs';
import path from 'node:path';

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${body}
</plist>
`;

// The two files of "<title>.workflow/Contents", keyed by name.
export function workflowFiles(title, bundleId) {
  const info = plist(`<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict><key>default</key><string>${xml(title)}</string></dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
			<key>NSSendFileTypes</key>
			<array><string>public.folder</string></array>
		</dict>
	</array>
</dict>`);
  const strings = '<dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>';
  const doc = plist(`<dict>
	<key>AMApplicationBuild</key><string>523</string>
	<key>AMApplicationVersion</key><string>2.10</string>
	<key>AMDocumentVersion</key><string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>${strings}
				<key>AMActionVersion</key><string>2.0.3</string>
				<key>AMApplication</key><array><string>Automator</string></array>
				<key>AMProvides</key>${strings}
				<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key><string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key><string>open -b ${xml(bundleId)} "$@"</string>
					<key>CheckedForUserDefaultShell</key><true/>
					<key>inputMethod</key><integer>1</integer>
					<key>shell</key><string>/bin/zsh</string>
					<key>source</key><string></string>
				</dict>
				<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key><string>2.0.3</string>
				<key>Class Name</key><string>RunShellScriptAction</string>
				<key>InputUUID</key><string>6C1D8D3E-1B7E-4E4B-9C59-2E1A0F6B7A01</string>
				<key>OutputUUID</key><string>6C1D8D3E-1B7E-4E4B-9C59-2E1A0F6B7A02</string>
				<key>UUID</key><string>6C1D8D3E-1B7E-4E4B-9C59-2E1A0F6B7A03</string>
				<key>UnlocalizedApplications</key><array><string>Automator</string></array>
			</dict>
		</dict>
	</array>
	<key>connectors</key><dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
		<key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key><integer>0</integer>
		<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>`);
  return { 'Info.plist': info, 'document.wflow': doc };
}

// Writes "<title>.workflow" into `servicesDir` when it is missing or differs, and touches nothing else there.
// Returns true when it wrote, so the caller knows to refresh Finder's list of services (pbs -update).
export function installWorkflow({ servicesDir, title, bundleId }) {
  const contents = path.join(servicesDir, `${title}.workflow`, 'Contents');
  const read = name => { try { return fs.readFileSync(path.join(contents, name), 'utf8'); } catch { return null; } };
  const files = Object.entries(workflowFiles(title, bundleId));
  if (files.every(([name, text]) => read(name) === text)) return false;
  fs.mkdirSync(contents, { recursive: true });
  for (const [name, text] of files) fs.writeFileSync(path.join(contents, name), text);
  return true;
}
