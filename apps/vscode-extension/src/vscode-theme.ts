/**
 * VS Code Theme Bridge
 *
 * Maps VS Code CSS custom properties to Plannotator's CSS variable system.
 * Used by the cookie proxy to inject a theme listener into the webview iframe,
 * and by the panel manager to read+send theme tokens from the wrapper page.
 */

// Each VS Code CSS variable can map to multiple Plannotator variables
// (e.g., editor foreground → foreground, card-foreground, popover-foreground).
const TOKEN_PAIRS: [string, string][] = [
  ["--vscode-editor-background", "--background"],
  ["--vscode-editor-foreground", "--foreground"],
  ["--vscode-sideBar-background", "--card"],
  ["--vscode-editor-foreground", "--card-foreground"],
  ["--vscode-editorWidget-background", "--popover"],
  ["--vscode-editor-foreground", "--popover-foreground"],
  ["--vscode-button-background", "--primary"],
  ["--vscode-button-foreground", "--primary-foreground"],
  ["--vscode-input-background", "--input"],
  ["--vscode-panel-border", "--border"],
  ["--vscode-focusBorder", "--ring"],
  ["--vscode-errorForeground", "--destructive"],
  ["--vscode-testing-iconPassed", "--success"],
  ["--vscode-editorWarning-foreground", "--warning"],
  ["--vscode-textLink-foreground", "--accent"],
  ["--vscode-descriptionForeground", "--muted-foreground"],
];

/** VS Code variable names the wrapper page needs to read */
export const VSCODE_VARS = [...new Set(TOKEN_PAIRS.map(([v]) => v))];

/**
 * Returns inline JS for the wrapper page (panel-manager.ts).
 * Reads VS Code CSS variables and posts them to the iframe.
 */
export function buildWrapperThemeScript(): string {
  const varsJson = JSON.stringify(VSCODE_VARS);
  return `<script>(function(){
  var vars=${varsJson};
  function readTheme(){
    var s=getComputedStyle(document.documentElement);
    var t={};
    for(var i=0;i<vars.length;i++){
      var v=s.getPropertyValue(vars[i]).trim();
      if(v)t[vars[i]]=v;
    }
    var kind=document.body.getAttribute("data-vscode-theme-kind")||"vscode-dark";
    return{type:"plannotator-vscode-theme",tokens:t,themeKind:kind};
  }
  function send(){
    var f=document.querySelector("iframe");
    if(f&&f.contentWindow)f.contentWindow.postMessage(readTheme(),"*");
  }
  window.addEventListener("load",function(){send();setTimeout(send,300);});
  var ob=new MutationObserver(function(){send();});
  ob.observe(document.documentElement,{attributes:true,attributeFilter:["style","class"]});
  ob.observe(document.body,{attributes:true,attributeFilter:["data-vscode-theme-kind"]});
})();</script>`;
}

/**
 * Returns inline JS injected into the iframe HTML (via cookie proxy).
 * Listens for theme messages from the wrapper and applies CSS overrides.
 */
export function buildThemeListenerScript(): string {
  const pairsJson = JSON.stringify(TOKEN_PAIRS);
  return `<script>(function(){
  window.__PLANNOTATOR_VSCODE=true;
  var pairs=${pairsJson};
  function hexToComponents(h){
    h=h.replace("#","");
    if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
  }
  function adjustBrightness(color,amount){
    if(!color)return null;
    var c=hexToComponents(color);
    var r=Math.min(255,Math.max(0,c[0]+amount));
    var g=Math.min(255,Math.max(0,c[1]+amount));
    var b=Math.min(255,Math.max(0,c[2]+amount));
    return"rgb("+r+","+g+","+b+")";
  }
  window.addEventListener("message",function(e){
    if(!e.data||e.data.type!=="plannotator-vscode-theme")return;
    var tokens=e.data.tokens;
    var kind=e.data.themeKind;
    var root=document.documentElement;
    for(var i=0;i<pairs.length;i++){
      var val=tokens[pairs[i][0]];
      if(val)root.style.setProperty(pairs[i][1],val);
    }
    var bg=tokens["--vscode-editor-background"];
    if(bg){
      var isDark=kind==="vscode-dark"||kind==="vscode-high-contrast";
      var muted=adjustBrightness(bg,isDark?20:-20);
      if(muted)root.style.setProperty("--muted",muted);
    }
    root.classList.remove("light");
    if(kind==="vscode-light"||kind==="vscode-high-contrast-light"){
      root.classList.add("light");
    }
  });
})();</script>`;
}
