async function t(n){try{const e=await(await fetch("/game-center/gomoku/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentSessionId:n})})).json();return e.ok&&e.playUrl?e.playUrl:null}catch{return null}}function r(n){window.open(n,"_blank","noopener,noreferrer")}export{t as c,r as o};
//# sourceMappingURL=game-center-BWU90ybN.js.map
