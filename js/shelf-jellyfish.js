/* ==========================================================================
   书架粒子水母 — v131 墨绿色 · 书虫助手同款粒子风格（Exact Visual Match）
   对齐 page-agent.js _bgAnimate 的所有视觉细节：
   1) 半透明覆盖清屏 → 粒子拖尾（随轨迹淡出）
   2) 每个粒子外层大光晕（每 3 个粒子 × 2.4 半径，淡 alpha）
   3) 双级连线：水母内部（bell/rim/tentacle）近邻连线 + 中心扩散弱连接
   4) 粒子闪烁：alpha *= 0.75 + 0.25*(0.5+0.5*sin(time + idx*0.7))
   5) 脉冲呼吸：每 2.6~4.1s 一次，水母整体轻微上冲
   6) 线宽：0.55 内部 / 0.35 外部
   7) 触手波动：segIdx 越大振幅越大，呼吸系数影响 bell/rim
   8) 冷色调配色（墨绿冷调，同色系 6 阶）
   - 单只 · 够大（size=150，帽宽≈300px / 触须≈260px）
   - 名字严格：书虫蛊
   - 无任何鼠标交互
   ========================================================================== */
(function () {
  'use strict';
  try {
    document.addEventListener('DOMContentLoaded', function () {
      var view = document.getElementById('shelfView');
      if (!view) return;
      if (typeof CanvasRenderingContext2D === 'undefined') return;

      // -------- 5 阶墨绿色配色（粒子本身是墨绿色）--------
      var PALETTE = [
        [ 34,  69,  48],  // 主色 --accent-deep #2b4530
        [ 58,  90,  64],  // 次色 --accent      #3a5a40
        [ 80, 122,  88],  // 柔色 --nav-bg-soft #4a6b50
        [ 85, 122,  92],  // 中色 --nav-bg-mid  #557a5c
        [ 31,  54,  35]   // 最深 --nav-bg 末端 #1f3623
      ];
      var CROSS_LINK_COLOR = [31, 54, 35]; // 跨区弱连线也用最深墨绿
      var NAME_TEXT = '书虫蛊';

      // -------- 创建 DOM（canvas / name / toggle / toast）并 prepend 到 shelfView --------
      var canvas = document.createElement('canvas');
      canvas.className = 'shelf-jellyfish';
      canvas.id = 'shelfJellyfish';
      canvas.style.pointerEvents = 'none';
      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'shelf-jellyfish-toggle';
      toggleBtn.id = 'jellyfishToggle';
      toggleBtn.textContent = '水母：开';
      toggleBtn.title = '显示/隐藏书架粒子水母';
      var toast = document.createElement('span');
      toast.className = 'shelf-jellyfish-toast';
      toast.id = 'jellyfishToast';
      toast.textContent = '';
      toast.style.pointerEvents = 'none';
      toast.style.background = 'rgba(34,197,94,0.92)';
      toast.style.color = '#fff';
      view.insertBefore(canvas, view.firstChild);
      view.appendChild(toggleBtn);
      view.appendChild(toast);

      // 鼠标追踪
      var mouse = { x: W * 0.5, y: H * 0.4, active: false };
      view.addEventListener('mousemove', function (e) {
        var rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.active = true;
      });
      view.addEventListener('mouseleave', function () {
        mouse.active = false;
      });

      var ctx = canvas.getContext('2d');
      var W = 0, H = 0;
      var enabled = true;
      try {
        var v = localStorage.getItem('shelf_jellyfish_enabled');
        if (v === 'false') enabled = false;
      } catch (e) { /* ignore */ }
      if (!enabled) {
        canvas.style.display = 'none';
        toggleBtn.textContent = '水母：关';
      }

      // -------- 尺寸适配 --------
      function resize() {
        var cs = view.getBoundingClientRect();
        W = Math.max(1, cs.width || 0);
        H = Math.max(1, cs.height || 0);
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resize();
      try {
        var ro = new ResizeObserver(function () { resize(); });
        ro.observe(view);
      } catch (e) {
        window.addEventListener('resize', resize);
      }

      // ======================================================================
      //  单只大水母 — 内部结构完全同 _initBgJellyfishes，但尺寸放大
      //  一只 size=150，粒子数 ≈ 一只大的 = bell(72)+ rim(22)+ tentacles(8×8=64) = 158
      // ======================================================================
      var jf = null;  // 就一只
      var idle = {
        time: 0,
        pulse: { nextAt: 2500, strength: 0 }
      };

      function initJellyfish() {
        var size = 130;
        var col = PALETTE[Math.floor(Math.random() * PALETTE.length)];
        var x0 = W * 0.5;
        var y0 = H * 0.4;

        var particles = [];

        // 1) 球体主体：Fibonacci 球面均匀分布
        var sphereN = 120;
        var golden = Math.PI * (3 - Math.sqrt(5));
        for (var i = 0; i < sphereN; i++) {
          var y_sp = 1 - (i / (sphereN - 1)) * 2;           // y: 1 → -1
          var r_sp = Math.sqrt(1 - y_sp * y_sp);
          var th_sp = golden * i;
          var jitter = 0.85 + Math.random() * 0.3;           // 轻微随机半径
          var bx = Math.cos(th_sp) * r_sp * size * jitter;
          var by = y_sp * size * jitter;
          var bz = Math.sin(th_sp) * r_sp * size * jitter;
          particles.push({
            ox: bx, oy: by, oz: bz,
            x: x0 + bx, y: y0 + by,
            r: 0.7 + Math.random() * 1.1,
            phase: Math.random() * Math.PI * 2,
            part: 'sphere',
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)]
          });
        }

        // 2) 球体内部填充粒子（增加体积感）
        var innerN = 40;
        for (var i2 = 0; i2 < innerN; i2++) {
          var r2 = size * (0.2 + Math.random() * 0.6);
          var th2 = Math.random() * Math.PI * 2;
          var ph2 = Math.acos(2 * Math.random() - 1);
          particles.push({
            ox: r2 * Math.sin(ph2) * Math.cos(th2),
            oy: r2 * Math.cos(ph2),
            oz: r2 * Math.sin(ph2) * Math.sin(th2),
            x: 0, y: 0,
            r: 0.5 + Math.random() * 0.7,
            phase: Math.random() * Math.PI * 2,
            part: 'inner',
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)]
          });
        }

        // 3) 触须：5 根 × 10 段，从球底部伸出
        var tentCount = 5;
        var segments = 10;
        for (var t = 0; t < tentCount; t++) {
          // 触须根部在球底部偏一定角度
          var tAngle = ((t + 0.5) / tentCount) * Math.PI * 2;
          var rootX = Math.cos(tAngle) * size * 0.35;
          var rootZ = Math.sin(tAngle) * size * 0.35;
          var rootY = size * 0.85;  // 底部
          for (var s = 0; s < segments; s++) {
            var ratio = (s + 1) / segments;
            var segLen = size * 0.25;
            var sx = rootX + Math.cos(tAngle) * segLen * ratio * 0.5 + (Math.random() - 0.5) * 3;
            var sy = rootY + segLen * ratio * 1.1;
            var sz = rootZ + Math.sin(tAngle) * segLen * ratio * 0.5;
            particles.push({
              ox: sx, oy: sy, oz: sz,
              x: x0 + sx, y: y0 + sy,
              r: 0.5 + (1 - ratio) * 0.8,
              phase: Math.random() * Math.PI * 2,
              part: 'tentacle',
              tentIdx: t,
              segIdx: s,
              color: PALETTE[Math.floor(Math.random() * PALETTE.length)]
            });
          }
        }

        jf = {
          x: x0, y: y0,
          baseX: x0, baseY: y0,
          vx: 0, vy: 0,
          size: size,
          color: col,
          alpha: 0.65,
          targetAlpha: 0.65,
          z: 0.9,
          t: Math.random() * Math.PI * 2,
          particles: particles,
          heading: 0,          // 推进方向
          rotY: 0,             // 3D Y 轴翻滚
          rotX: 0,             // 3D X 轴俯仰
          pulsePhase: 0,       // 脉动相位 0~1
          pulsePeriod: 180,    // 一个完整脉动周期（帧数 ≈ 3秒）
          driftAngle: 0        // 方向漂移累积
        };
      }
      initJellyfish();

      // ======================================================================
      //  主循环 — 完全复刻 _bgAnimate 节奏
      // ======================================================================
      var rAF = 0;
      var START = Date.now();

      function frame() {
        if (!enabled) return;
        rAF = requestAnimationFrame(frame);

        // 1) 半透明覆盖清屏 → 拖尾效果（降低 alpha 让残影更长）
        ctx.fillStyle = 'rgba(239, 233, 220, 0.04)';
        ctx.fillRect(0, 0, W, H);

        // 2) Idle 脉冲（同 assistant：每 2600+rand(1500) 一次）
        idle.time += 16;
        if (idle.time >= idle.pulse.nextAt) {
          idle.pulse.strength = 1.0;
          idle.pulse.nextAt = idle.time + 2600 + Math.random() * 1500;
        }
        var pulseK = idle.pulse.strength;
        if (pulseK > 0) idle.pulse.strength = Math.max(0, pulseK - 0.022);

        // ---- 3) 写实运动：非对称脉动 + 离散推力 + 滑行改向 ----
        jf.t += 0.008;
        // 脉动相位推进（一个周期 = pulsePeriod 帧）
        var prevPhase = jf.pulsePhase;
        jf.pulsePhase += 1 / jf.pulsePeriod;
        if (jf.pulsePhase >= 1) {
          jf.pulsePhase -= 1;
          // 新周期：随机微调周期长度和方向
          jf.pulsePeriod = 160 + Math.floor(Math.random() * 60);
        }
        var ph = jf.pulsePhase;

        // 非对称脉动曲线：快收缩(0~0.15) + 推力峰(0.15~0.3) + 慢舒张(0.3~1.0)
        // bellShape: 0=完全舒张, 1=完全收缩
        var bellShape;
        if (ph < 0.15) {
          bellShape = ph / 0.15;                       // 快速收缩
        } else if (ph < 0.30) {
          bellShape = 1.0 - (ph - 0.15) / 0.15 * 0.2;  // 峰值后微松
        } else {
          bellShape = 0.8 * Math.pow(1 - (ph - 0.30) / 0.70, 1.8); // 慢舒张
        }
        var jBreath = 1.0 - bellShape * 0.5;  // 兼容旧变量名：1=舒张, 0.5=收缩

        // 离散推力：仅在 0.12~0.22 区间施加强推力
        var thrustForce = 0;
        if (ph >= 0.12 && ph < 0.22) {
          var tp = (ph - 0.12) / 0.10;
          thrustForce = Math.sin(tp * Math.PI) * 0.06;  // 正弦推力包络
        }

        // 方向漂移：仅在滑行阶段(>0.4)缓慢改方向
        if (ph > 0.4) {
          jf.driftAngle += 0.0015;
          var driftH = Math.sin(jf.driftAngle * 2.3) * 0.5 + Math.sin(jf.driftAngle * 0.7) * 0.3;
          var hdDelta = driftH - jf.heading;
          while (hdDelta > Math.PI) hdDelta -= Math.PI * 2;
          while (hdDelta < -Math.PI) hdDelta += Math.PI * 2;
          jf.heading += hdDelta * 0.002;
        }

        // 头部方向
        var headDX = Math.sin(jf.heading);
        var headDY = -Math.cos(jf.heading);

        // 施加推力
        if (thrustForce > 0) {
          jf.vx += headDX * thrustForce;
          jf.vy += headDY * thrustForce;
        }

        // 3D 体态旋转：Y 轴持续慢翻滚，X 轴在推力时前倾
        jf.rotY += 0.0035;
        var targetRotX = thrustForce * 0.8;   // 推力时前倾
        jf.rotX += (targetRotX - jf.rotX) * 0.05;

        // 鼠标追随（慢）+ 弱中心回引
        if (mouse.active) {
          // heading 也缓慢转向鼠标
          var mdx = mouse.x - jf.x, mdy = mouse.y - jf.y;
          var mouseHeading = Math.atan2(mdx, -mdy);
          var mhdDelta = mouseHeading - jf.heading;
          while (mhdDelta > Math.PI) mhdDelta -= Math.PI * 2;
          while (mhdDelta < -Math.PI) mhdDelta += Math.PI * 2;
          jf.heading += mhdDelta * 0.004;
          // 慢速吸引
          var distM = Math.sqrt(mdx * mdx + mdy * mdy);
          if (distM > 30) {  // 太近不推
            jf.vx += mdx / distM * 0.012;
            jf.vy += mdy / distM * 0.012;
          }
        } else {
          var cx = W * 0.5, cy = H * 0.45;
          jf.vx += (cx - jf.x) * 0.00010;
          jf.vy += (cy - jf.y) * 0.00010;
        }

        // 边界防撞
        var margin = jf.size * 1.3;
        if (jf.x < margin) { jf.vx += (margin - jf.x) / margin * 0.12; }
        if (jf.x > W - margin) { jf.vx -= (jf.x - (W - margin)) / margin * 0.12; }
        if (jf.y < margin) { jf.vy += (margin - jf.y) / margin * 0.12; }
        if (jf.y > H - margin) { jf.vy -= (jf.y - (H - margin)) / margin * 0.12; }

        // 阻尼（滑行时较强衰减）+ 速度限制
        var damping = (ph > 0.3 && ph < 0.95) ? 0.965 : 0.985;
        jf.vx *= damping;
        jf.vy *= damping;
        var vv = jf.vx * jf.vx + jf.vy * jf.vy;
        if (vv > 0.7) { var vs = Math.sqrt(0.7 / vv); jf.vx *= vs; jf.vy *= vs; }
        jf.x += jf.vx;
        jf.y += jf.vy;

        // ---- 4) 更新粒子坐标（球体呼吸缩放 + 触须拖尾 + 3D 旋转 + 透视）----
        var ptsArr = jf.particles;
        var cosY = Math.cos(jf.rotY), sinY = Math.sin(jf.rotY);
        var cosX = Math.cos(jf.rotX), sinX = Math.sin(jf.rotX);
        var PERSP = 350;
        // 球体呼吸：收缩时整体缩小，舒张时恢复
        var pulseScale = 1.0 - bellShape * 0.12;
        // 触须拖尾
        var speedMag = Math.sqrt(jf.vx * jf.vx + jf.vy * jf.vy);
        var trailK = Math.min(speedMag * 14, 22);
        var trailDX = -jf.vx / (speedMag + 0.01) * trailK;
        var trailDY = -jf.vy / (speedMag + 0.01) * trailK;
        var tentAmp = 1.0 + speedMag * 4;

        for (var p = 0; p < ptsArr.length; p++) {
          var pt = ptsArr[p];
          pt.gx2 = pt.gx1; pt.gy2 = pt.gy1;
          pt.gx1 = pt.x;   pt.gy1 = pt.y;

          var lx, ly, lz;
          if (pt.part === 'tentacle') {
            // 触须：波动 + 拖尾
            var tentPhase = jf.t * 1.8 + pt.phase;
            var segRatio = (pt.segIdx + 1) / 10;
            var tentWave = Math.sin(tentPhase) * (2.0 + pt.segIdx * 1.0) * tentAmp;
            var tentSway = Math.cos(tentPhase * 0.6) * 4 * segRatio;
            lx = pt.ox + tentWave * 0.7 + tentSway;
            ly = pt.oy + Math.cos(tentPhase * 0.8) * 1.5;
            lz = pt.oz;
            lx += trailDX * segRatio;
            ly += trailDY * segRatio;
          } else if (pt.part === 'inner') {
            // 内部粒子：轻微抖动
            lx = pt.ox * pulseScale + Math.sin(jf.t * 1.3 + pt.phase) * 1.0;
            ly = pt.oy * pulseScale + Math.cos(jf.t * 1.0 + pt.phase) * 1.0;
            lz = pt.oz * pulseScale;
          } else { // sphere
            // 球面粒子：整体呼吸缩放 + 轻微抖动
            lx = pt.ox * pulseScale + Math.sin(jf.t * 1.1 + pt.phase) * 0.8;
            ly = pt.oy * pulseScale + Math.cos(jf.t * 0.9 + pt.phase) * 0.8;
            lz = pt.oz * pulseScale;
          }
          // 3D 旋转
          var x1 = lx * cosY - lz * sinY;
          var z1 = lx * sinY + lz * cosY;
          var y1 = ly * cosX - z1 * sinX;
          var z2 = ly * sinX + z1 * cosX;
          var scale = PERSP / (PERSP + z2);
          pt.x = jf.x + x1 * scale;
          pt.y = jf.y + y1 * scale;
          pt.pscale = scale;
        }

        // ---- 5) 收集所有粒子（含残影位置 + 3D 缩放）----
        var allPts = [];
        for (var pi = 0; pi < ptsArr.length; pi++) {
          var pp = ptsArr[pi];
          allPts.push({
            x: pp.x, y: pp.y, r: pp.r,
            pscale: pp.pscale || 1,
            gx1: pp.gx1, gy1: pp.gy1,
            gx2: pp.gx2, gy2: pp.gy2,
            z: jf.z, alpha: jf.alpha,
            color: pp.color, part: pp.part
          });
        }

        // ---- 6) 绘制：球体网格 + 触须连线 ----
        // 6a) 球面+内部粒子近邻连线（构成球体网格）
        var spherePts = [];
        for (var si_p = 0; si_p < ptsArr.length; si_p++) {
          if (ptsArr[si_p].part === 'sphere' || ptsArr[si_p].part === 'inner') spherePts.push(ptsArr[si_p]);
        }
        var linkDist = 48;
        ctx.lineWidth = 0.65;
        if (jf.alpha >= 0.05) {
          for (var a = 0; a < spherePts.length; a++) {
            var pa = spherePts[a];
            for (var b = a + 1; b < spherePts.length; b++) {
              var pb = spherePts[b];
              var ddxL = pa.x - pb.x, ddyL = pa.y - pb.y;
              var ddL = ddxL * ddxL + ddyL * ddyL;
              if (ddL < linkDist * linkDist) {
                var distL = Math.sqrt(ddL);
                var opL = (1 - distL / linkDist) * 0.6 * jf.alpha;
                if (opL < 0.02) continue;
                var lc = pa.color;
                ctx.strokeStyle = 'rgba(' + lc[0] + ',' + lc[1] + ',' + lc[2] + ',' + opL + ')';
                ctx.beginPath();
                ctx.moveTo(pa.x, pa.y);
                ctx.lineTo(pb.x, pb.y);
                ctx.stroke();
              }
            }
          }
        }

        // 6b) 触须链式连线（杂乱，随机跳过+交叉）
        var tentMap = {};
        var tentList = [];
        for (var ti = 0; ti < ptsArr.length; ti++) {
          var tp = ptsArr[ti];
          if (tp.part !== 'tentacle') continue;
          if (!tentMap[tp.tentIdx]) { tentMap[tp.tentIdx] = []; tentList.push(tp.tentIdx); }
          tentMap[tp.tentIdx].push(tp);
        }
        // 链式（断裂感）
        ctx.lineWidth = 0.55;
        for (var tk in tentMap) {
          var segs = tentMap[tk].sort(function(a,b){ return a.segIdx - b.segIdx; });
          for (var si = 0; si < segs.length - 1; si++) {
            if (Math.random() < 0.12) continue;
            var s0 = segs[si], s1 = segs[si + 1];
            var sdx = s0.x - s1.x, sdy = s0.y - s1.y;
            var sd = sdx * sdx + sdy * sdy;
            if (sd < 120 * 120) {
              var sop = (0.4 + Math.random() * 0.3) * jf.alpha;
              var sc = s0.color;
              ctx.strokeStyle = 'rgba(' + sc[0] + ',' + sc[1] + ',' + sc[2] + ',' + sop + ')';
              ctx.beginPath();
              ctx.moveTo(s0.x, s0.y);
              ctx.lineTo(s1.x, s1.y);
              ctx.stroke();
            }
          }
        }
        // 跨触须交叉
        ctx.lineWidth = 0.35;
        for (var ci2 = 0; ci2 < tentList.length; ci2++) {
          var tIdxA = tentList[ci2];
          var tIdxB = tentList[(ci2 + 1) % tentList.length];
          var segsA = tentMap[tIdxA];
          var segsB = tentMap[tIdxB];
          if (!segsA || !segsB) continue;
          for (var si2 = 2; si2 < segsA.length; si2 += 2) {
            var pa2 = segsA[si2];
            for (var si3 = 0; si3 < segsB.length; si3++) {
              var pb2 = segsB[si3];
              if (Math.abs(pb2.segIdx - pa2.segIdx) > 2) continue;
              var cdx = pa2.x - pb2.x, cdy = pa2.y - pb2.y;
              var cd2 = cdx * cdx + cdy * cdy;
              if (cd2 < 40 * 40) {
                var cop = (1 - Math.sqrt(cd2) / 40) * 0.25 * jf.alpha;
                if (cop > 0.02) {
                  var cc = pa2.color;
                  ctx.strokeStyle = 'rgba(' + cc[0] + ',' + cc[1] + ',' + cc[2] + ',' + cop + ')';
                  ctx.beginPath();
                  ctx.moveTo(pa2.x, pa2.y);
                  ctx.lineTo(pb2.x, pb2.y);
                  ctx.stroke();
                }
              }
            }
          }
        }

        // 6c) 球底→触须根部连线
        ctx.lineWidth = 0.4;
        var tentRoots = [];
        for (var bi3 = 0; bi3 < ptsArr.length; bi3++) {
          if (ptsArr[bi3].part === 'tentacle' && ptsArr[bi3].segIdx === 0) tentRoots.push(ptsArr[bi3]);
        }
        for (var bi4 = 0; bi4 < spherePts.length; bi4++) {
          var spt = spherePts[bi4];
          var bestD = 1e9, bestP = null;
          for (var bi5 = 0; bi5 < tentRoots.length; bi5++) {
            var rp = tentRoots[bi5];
            var bdx = spt.x - rp.x, bdy = spt.y - rp.y;
            var bd = bdx * bdx + bdy * bdy;
            if (bd < bestD) { bestD = bd; bestP = rp; }
          }
          if (bestP && bestD < 55 * 55) {
            var bop = (1 - Math.sqrt(bestD) / 55) * 0.3 * jf.alpha;
            var bc = spt.color;
            ctx.strokeStyle = 'rgba(' + bc[0] + ',' + bc[1] + ',' + bc[2] + ',' + bop + ')';
            ctx.beginPath();
            ctx.moveTo(spt.x, spt.y);
            ctx.lineTo(bestP.x, bestP.y);
            ctx.stroke();
          }
        }

        // ---- 7) 绘制：残影 + 粒子 + 光晕（3D 透视缩放）----
        for (var di = 0; di < allPts.length; di++) {
          var dp = allPts[di];
          var flick = 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(idle.time / 1200 + di * 0.7));
          var alpha = dp.alpha * flick;
          var col = dp.color;
          var depthScale = dp.pscale;
          var sizeScale = (dp.part === 'tentacle' ? 0.6 : dp.part === 'inner' ? 0.7 : 1.0) * depthScale;
          // 残影2（最旧，最淡）
          if (dp.gx2 != null) {
            ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.06 + ')';
            ctx.beginPath();
            ctx.arc(dp.gx2, dp.gy2, dp.r * sizeScale * 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
          // 残影1（较新，较淡）
          if (dp.gx1 != null) {
            ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.12 + ')';
            ctx.beginPath();
            ctx.arc(dp.gx1, dp.gy1, dp.r * sizeScale * 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
          // 主粒子
          ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.95 + ')';
          ctx.beginPath();
          ctx.arc(dp.x, dp.y, dp.r * sizeScale, 0, Math.PI * 2);
          ctx.fill();
          // 外层光晕
          if (di % 3 === 0) {
            ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha * 0.18 + ')';
            ctx.beginPath();
            ctx.arc(dp.x, dp.y, dp.r * sizeScale * 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }

      }

      if (enabled) rAF = requestAnimationFrame(frame);

      // -------- 切换按钮 --------
      function showToast(text) {
        toast.textContent = text;
        toast.classList.add('show');
        setTimeout(function () { toast.classList.remove('show'); }, 1800);
      }
      toggleBtn.addEventListener('click', function () {
        enabled = !enabled;
        try { localStorage.setItem('shelf_jellyfish_enabled', enabled ? 'true' : 'false'); } catch (e) { /* ignore */ }
        toggleBtn.textContent = enabled ? '水母：开' : '水母：关';
        if (enabled) {
          canvas.style.display = '';
          showToast('已开启');
          if (!rAF) rAF = requestAnimationFrame(frame);
        } else {
          canvas.style.display = 'none';
          showToast('已关闭');
          if (rAF) { cancelAnimationFrame(rAF); rAF = 0; }
          // 关闭时清一次屏（防止半透明覆盖留痕）
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      });
    });
  } catch (err) {
    try { console.error('[shelf-jellyfish]', err); } catch (e) { /* empty */ }
  }
})();
