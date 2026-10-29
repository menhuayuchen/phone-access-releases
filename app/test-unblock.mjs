// 验证 screen-server.mjs 里 shellUnblock 用的那段 PowerShell 真的能跑通
import { spawnSync } from 'node:child_process';

const ps = [
  'Add-Type @"',
  'using System;using System.Runtime.InteropServices;',
  'public class DshFg{',
  '[DllImport("user32.dll")] public static extern IntPtr GetShellWindow();',
  '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h,bool alt);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);',
  'public static string Fg(){IntPtr h=GetForegroundWindow();var s=new System.Text.StringBuilder(160);GetWindowText(h,s,160);return s.ToString();}',
  '}',
  '"@',
  '$b=[DshFg]::Fg();',
  '[DshFg]::SwitchToThisWindow([DshFg]::GetShellWindow(),$true);',
  'Start-Sleep -Milliseconds 250;',
  '"unblock: [" + $b + "] -> [" + [DshFg]::Fg() + "]"',
].join('\n');

const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log('status=' + r.status);
console.log('stdout=' + (r.stdout || '').trim());
console.log('stderr=' + (r.stderr || '').trim().slice(0, 400));
