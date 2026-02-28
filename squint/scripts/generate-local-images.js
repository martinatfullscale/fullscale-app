#!/usr/bin/env node

/**
 * ============================================================
 * SQUINT — Free Local Image Generator (No API, No Cost)
 * ============================================================
 *
 * Generates stylized game images locally using Node.js Canvas.
 * No API keys, no costs, no internet required.
 * You own every image generated.
 *
 * SETUP (one time):
 *   npm install canvas --save-dev
 *
 * USAGE:
 *   node scripts/generate-local-images.js                     # Generate all
 *   node scripts/generate-local-images.js --category landmarks  # One category
 *   node scripts/generate-local-images.js --list                # List all prompts
 *
 * WHAT IT CREATES:
 *   Stylized artistic images using geometric shapes, gradients,
 *   patterns, and text. Each image is visually distinct and
 *   recognizable when viewed at full size, but challenging when tiny.
 *
 * CUSTOMIZING:
 *   Edit the SCENE_CONFIGS below to change colors, shapes, and compositions.
 *   Each scene is a function that draws on a Canvas context.
 *
 * ============================================================
 */

let createCanvas;
try {
  ({ createCanvas } = require('canvas'));
} catch {
  console.error('\n  Canvas module not installed. Run:\n');
  console.error('    cd squint && npm install canvas --save-dev\n');
  console.error('  Then try again.\n');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');

const SIZE = 800; // px (square images)
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'images');

// ────────────────────────────────────────────
// Drawing helpers
// ────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function drawGradientBg(ctx, colors) {
  const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

function drawCircle(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawStar(ctx, cx, cy, r, points, color) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? r : r * 0.4;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawTriangle(ctx, x, y, size, color, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(-size * 0.866, size * 0.5);
  ctx.lineTo(size * 0.866, size * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawText(ctx, text, x, y, size, color, align = 'center') {
  ctx.font = `bold ${size}px Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function drawRoundedRect(ctx, x, y, w, h, r, color) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ────────────────────────────────────────────
// Scene drawing functions — LANDMARKS
// ────────────────────────────────────────────

const LANDMARK_SCENES = {
  'eiffel-tower': (ctx) => {
    drawGradientBg(ctx, ['#1a1a2e', '#16213e', '#e94560']);
    // Tower shape
    ctx.fillStyle = '#4a4a4a';
    ctx.beginPath();
    ctx.moveTo(370, 100); ctx.lineTo(430, 100);
    ctx.lineTo(500, 700); ctx.lineTo(300, 700);
    ctx.closePath();
    ctx.fill();
    // Cross beams
    ctx.fillStyle = '#666';
    ctx.fillRect(330, 250, 140, 15);
    ctx.fillRect(315, 450, 170, 15);
    // Glow
    drawCircle(ctx, 400, 80, 20, '#FFD700');
    // Stars
    for (let i = 0; i < 30; i++) {
      drawCircle(ctx, randomBetween(0, SIZE), randomBetween(0, 300), randomBetween(1, 3), '#FFFFFF');
    }
  },

  'great-wall': (ctx) => {
    drawGradientBg(ctx, ['#87CEEB', '#E8D5B7', '#8B7355']);
    // Mountains
    for (let i = 0; i < 5; i++) {
      const x = i * 200 - 50;
      const h = randomBetween(200, 400);
      drawTriangle(ctx, x + 100, SIZE - h, h * 0.8, `rgba(80, 100, 80, ${0.3 + i * 0.1})`);
    }
    // Wall winding across
    ctx.strokeStyle = '#8B7355';
    ctx.lineWidth = 30;
    ctx.beginPath();
    ctx.moveTo(0, 500);
    ctx.quadraticCurveTo(200, 350, 400, 400);
    ctx.quadraticCurveTo(600, 450, 800, 300);
    ctx.stroke();
    // Towers on wall
    drawRoundedRect(ctx, 185, 330, 30, 50, 4, '#A0856B');
    drawRoundedRect(ctx, 385, 380, 30, 50, 4, '#A0856B');
    drawRoundedRect(ctx, 585, 330, 30, 50, 4, '#A0856B');
  },

  'statue-of-liberty': (ctx) => {
    drawGradientBg(ctx, ['#1a1a2e', '#3a506b', '#5bc0be']);
    // Pedestal
    drawRoundedRect(ctx, 300, 550, 200, 200, 8, '#A0856B');
    // Body
    ctx.fillStyle = '#4A7C59';
    ctx.beginPath();
    ctx.moveTo(350, 550); ctx.lineTo(450, 550);
    ctx.lineTo(430, 250); ctx.lineTo(370, 250);
    ctx.closePath();
    ctx.fill();
    // Crown
    for (let i = 0; i < 7; i++) {
      const angle = -Math.PI + (i / 6) * Math.PI;
      const x = 400 + Math.cos(angle) * 50;
      const y = 220 + Math.sin(angle) * 50;
      ctx.fillStyle = '#4A7C59';
      ctx.fillRect(x - 3, y - 30, 6, 30);
    }
    // Head
    drawCircle(ctx, 400, 230, 30, '#4A7C59');
    // Torch
    ctx.fillStyle = '#4A7C59';
    ctx.fillRect(445, 150, 8, 100);
    drawCircle(ctx, 449, 140, 20, '#FFD700');
    // Water
    ctx.fillStyle = 'rgba(91, 192, 190, 0.3)';
    ctx.fillRect(0, 700, SIZE, 100);
  },

  'taj-mahal': (ctx) => {
    drawGradientBg(ctx, ['#FF9A56', '#FFD194', '#F5F5DC']);
    // Reflecting pool
    ctx.fillStyle = 'rgba(100, 180, 200, 0.4)';
    ctx.fillRect(200, 600, 400, 150);
    // Main dome building
    drawRoundedRect(ctx, 280, 350, 240, 250, 8, '#F5F5DC');
    // Main dome
    ctx.beginPath();
    ctx.arc(400, 350, 100, Math.PI, 0);
    ctx.fillStyle = '#FAFAFA';
    ctx.fill();
    // Spire
    ctx.fillStyle = '#DAA520';
    ctx.fillRect(396, 240, 8, 40);
    drawCircle(ctx, 400, 235, 8, '#DAA520');
    // Minarets
    for (const x of [200, 600]) {
      ctx.fillStyle = '#F0EAD6';
      ctx.fillRect(x - 10, 300, 20, 300);
      ctx.beginPath();
      ctx.arc(x, 300, 15, Math.PI, 0);
      ctx.fill();
    }
    // Arch
    ctx.beginPath();
    ctx.arc(400, 500, 40, Math.PI, 0);
    ctx.fillStyle = '#333';
    ctx.fill();
  },

  'colosseum': (ctx) => {
    drawGradientBg(ctx, ['#87CEEB', '#DEB887', '#C19A6B']);
    // Main oval structure
    ctx.fillStyle = '#C19A6B';
    ctx.beginPath();
    ctx.ellipse(400, 450, 300, 200, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner darker area
    ctx.fillStyle = '#8B7355';
    ctx.beginPath();
    ctx.ellipse(400, 450, 250, 160, 0, 0, Math.PI * 2);
    ctx.fill();
    // Arches across the top
    ctx.fillStyle = '#D2B48C';
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const x = 400 + Math.cos(angle) * 270;
      const y = 450 + Math.sin(angle) * 180;
      drawRoundedRect(ctx, x - 10, y - 30, 20, 60, 8, '#D2B48C');
    }
    // Broken edge (ruined wall)
    ctx.fillStyle = '#87CEEB';
    ctx.beginPath();
    ctx.moveTo(550, 250); ctx.lineTo(700, 280);
    ctx.lineTo(700, 450); ctx.lineTo(550, 400);
    ctx.closePath();
    ctx.fill();
  },

  'machu-picchu': (ctx) => {
    drawGradientBg(ctx, ['#B0C4DE', '#90EE90', '#6B8E23']);
    // Dramatic mountain peak behind
    drawTriangle(ctx, 400, 100, 350, '#4A6741');
    drawTriangle(ctx, 250, 200, 250, '#5A7751');
    drawTriangle(ctx, 600, 150, 300, '#3A5731');
    // Terraces
    for (let i = 0; i < 6; i++) {
      const y = 450 + i * 40;
      ctx.fillStyle = `rgb(${100 + i * 10}, ${140 + i * 10}, ${80 + i * 5})`;
      ctx.fillRect(200 - i * 20, y, 400 + i * 40, 35);
    }
    // Stone buildings
    for (let i = 0; i < 4; i++) {
      drawRoundedRect(ctx, 250 + i * 80, 400, 60, 50, 4, '#A0856B');
    }
    // Clouds
    for (let i = 0; i < 3; i++) {
      const cx = 100 + i * 300;
      drawCircle(ctx, cx, 80 + i * 20, 60, 'rgba(255,255,255,0.5)');
      drawCircle(ctx, cx + 40, 70 + i * 20, 50, 'rgba(255,255,255,0.5)');
    }
  },

  'sydney-opera-house': (ctx) => {
    drawGradientBg(ctx, ['#4169E1', '#1E90FF', '#87CEEB']);
    // Water
    ctx.fillStyle = '#1E6EC0';
    ctx.fillRect(0, 500, SIZE, 300);
    // Shells/sails
    ctx.fillStyle = '#F0F0F0';
    const shells = [
      { x: 250, y: 480, r: 120, start: -0.8, end: -0.1 },
      { x: 350, y: 460, r: 140, start: -0.8, end: -0.1 },
      { x: 460, y: 450, r: 150, start: -0.8, end: -0.1 },
      { x: 520, y: 470, r: 110, start: -0.8, end: -0.1 },
    ];
    shells.forEach(({ x, y, r }) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 30, y - r * 1.2, x + 60, y);
      ctx.fill();
    });
    // Base platform
    ctx.fillStyle = '#C0C0C0';
    ctx.fillRect(200, 480, 400, 30);
    // Bridge in background
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(700, 500, 200, Math.PI, 0);
    ctx.stroke();
  },

  'big-ben': (ctx) => {
    drawGradientBg(ctx, ['#2C3E50', '#34495E', '#95A5A6']);
    // Tower body
    ctx.fillStyle = '#B8860B';
    ctx.fillRect(340, 150, 120, 600);
    // Clock face
    drawCircle(ctx, 400, 280, 50, '#F5F5DC');
    drawCircle(ctx, 400, 280, 45, '#FFF');
    // Clock hands
    ctx.strokeStyle = '#1C1C1C';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(400, 280); ctx.lineTo(400, 245);
    ctx.moveTo(400, 280); ctx.lineTo(425, 280);
    ctx.stroke();
    // Spire
    drawTriangle(ctx, 400, 100, 60, '#B8860B');
    // Windows
    for (let y = 400; y < 700; y += 60) {
      ctx.fillStyle = '#FFE4B5';
      ctx.fillRect(370, y, 20, 35);
      ctx.fillRect(410, y, 20, 35);
    }
    // Rain
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 50; i++) {
      const x = randomBetween(0, SIZE);
      const y = randomBetween(0, SIZE);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x - 2, y + 10);
      ctx.stroke();
    }
  },

  'christ-redeemer': (ctx) => {
    drawGradientBg(ctx, ['#FF6B6B', '#FFA07A', '#FFD700']);
    // Mountain
    drawTriangle(ctx, 400, 250, 300, '#2F4F4F');
    // Statue body
    ctx.fillStyle = '#D3D3D3';
    ctx.fillRect(385, 180, 30, 150);
    // Arms outstretched
    ctx.fillRect(280, 200, 240, 20);
    // Head
    drawCircle(ctx, 400, 170, 20, '#D3D3D3');
    // Clouds below
    for (let i = 0; i < 8; i++) {
      drawCircle(ctx, randomBetween(100, 700), randomBetween(450, 550), randomBetween(40, 80), 'rgba(255,255,255,0.4)');
    }
    // City below
    for (let i = 0; i < 15; i++) {
      const h = randomBetween(30, 80);
      ctx.fillStyle = `rgba(50, 50, 50, ${randomBetween(0.3, 0.6)})`;
      ctx.fillRect(randomBetween(0, SIZE), SIZE - h, randomBetween(15, 30), h);
    }
  },

  'golden-gate': (ctx) => {
    drawGradientBg(ctx, ['#B0C4DE', '#DCDCDC', '#87CEEB']);
    // Water
    ctx.fillStyle = '#1E6EC0';
    ctx.fillRect(0, 550, SIZE, 250);
    // Fog
    for (let i = 0; i < 5; i++) {
      drawCircle(ctx, randomBetween(0, SIZE), randomBetween(300, 500), randomBetween(80, 150), 'rgba(200,200,200,0.3)');
    }
    // Bridge towers
    ctx.fillStyle = '#C0392B';
    ctx.fillRect(250, 200, 30, 400);
    ctx.fillRect(520, 200, 30, 400);
    // Cables
    ctx.strokeStyle = '#C0392B';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(0, 400);
    ctx.quadraticCurveTo(265, 200, 265, 220);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(265, 220);
    ctx.quadraticCurveTo(400, 350, 535, 220);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(535, 220);
    ctx.quadraticCurveTo(535, 200, 800, 400);
    ctx.stroke();
    // Road deck
    ctx.fillStyle = '#C0392B';
    ctx.fillRect(0, 380, SIZE, 12);
    // Vertical cables
    for (let x = 100; x < SIZE; x += 50) {
      ctx.strokeStyle = '#C0392B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 380); ctx.lineTo(x, 380 - Math.abs(400 - x) * 0.2);
      ctx.stroke();
    }
  },
};

// ────────────────────────────────────────────
// Scene drawing functions — WHAT'S HAPPENING
// ────────────────────────────────────────────

const WHATS_HAPPENING_SCENES = {
  'man-on-bike': (ctx) => {
    drawGradientBg(ctx, ['#FF9A56', '#FFD194', '#FFF3E0']);
    // Road
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 600, SIZE, 200);
    ctx.strokeStyle = '#FFF';
    ctx.lineWidth = 3;
    ctx.setLineDash([20, 20]);
    ctx.beginPath(); ctx.moveTo(0, 650); ctx.lineTo(SIZE, 650); ctx.stroke();
    ctx.setLineDash([]);
    // Bike wheels
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 5;
    drawCircle(ctx, 300, 560, 50, 'transparent');
    ctx.beginPath(); ctx.arc(300, 560, 50, 0, Math.PI * 2); ctx.stroke();
    drawCircle(ctx, 500, 560, 50, 'transparent');
    ctx.beginPath(); ctx.arc(500, 560, 50, 0, Math.PI * 2); ctx.stroke();
    // Frame
    ctx.strokeStyle = '#E74C3C';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(300, 560); ctx.lineTo(400, 460);
    ctx.lineTo(500, 560); ctx.moveTo(400, 460);
    ctx.lineTo(350, 440); ctx.moveTo(400, 460);
    ctx.lineTo(450, 440);
    ctx.stroke();
    // Person (stick figure)
    drawCircle(ctx, 390, 400, 25, '#FFD194');
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(390, 425); ctx.lineTo(400, 460);
    ctx.stroke();
    // Buildings in background
    for (let i = 0; i < 6; i++) {
      const h = randomBetween(150, 350);
      drawRoundedRect(ctx, i * 140, SIZE - 200 - h, 120, h, 4, `rgba(100, 100, 120, ${0.3 + i * 0.05})`);
    }
  },

  'woman-jumping': (ctx) => {
    drawGradientBg(ctx, ['#FF6B6B', '#FFA07A', '#FFD700']);
    // Beach sand
    ctx.fillStyle = '#F4D03F';
    ctx.fillRect(0, 600, SIZE, 200);
    // Ocean line
    ctx.fillStyle = '#3498DB';
    ctx.fillRect(0, 550, SIZE, 60);
    // Jumping silhouette
    ctx.fillStyle = '#1C1C1C';
    // Head
    drawCircle(ctx, 400, 250, 30, '#1C1C1C');
    // Body
    ctx.fillRect(390, 280, 20, 80);
    // Arms up in V shape
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#1C1C1C';
    ctx.beginPath();
    ctx.moveTo(400, 300); ctx.lineTo(340, 230);
    ctx.moveTo(400, 300); ctx.lineTo(460, 230);
    ctx.stroke();
    // Legs
    ctx.beginPath();
    ctx.moveTo(400, 360); ctx.lineTo(350, 430);
    ctx.moveTo(400, 360); ctx.lineTo(450, 430);
    ctx.stroke();
    // Sun
    drawCircle(ctx, 650, 120, 80, '#FFD700');
    // Rays
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(650 + Math.cos(angle) * 90, 120 + Math.sin(angle) * 90);
      ctx.lineTo(650 + Math.cos(angle) * 130, 120 + Math.sin(angle) * 130);
      ctx.stroke();
    }
  },

  'kid-kite': (ctx) => {
    drawGradientBg(ctx, ['#87CEEB', '#90EE90', '#2ECC71']);
    // Field
    ctx.fillStyle = '#2ECC71';
    ctx.fillRect(0, 500, SIZE, 300);
    // Kid stick figure
    drawCircle(ctx, 350, 440, 20, '#FFD194');
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(350, 460); ctx.lineTo(350, 530);
    ctx.moveTo(350, 530); ctx.lineTo(330, 580);
    ctx.moveTo(350, 530); ctx.lineTo(370, 580);
    ctx.moveTo(350, 480); ctx.lineTo(380, 460);
    ctx.stroke();
    // Kite string
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(380, 460);
    ctx.quadraticCurveTo(500, 300, 550, 150);
    ctx.stroke();
    // Kite (diamond)
    ctx.fillStyle = '#E74C3C';
    ctx.beginPath();
    ctx.moveTo(550, 100); ctx.lineTo(590, 150);
    ctx.lineTo(550, 200); ctx.lineTo(510, 150);
    ctx.closePath();
    ctx.fill();
    // Kite tail
    ctx.strokeStyle = '#9B59B6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(550, 200);
    ctx.quadraticCurveTo(580, 240, 560, 280);
    ctx.quadraticCurveTo(540, 320, 570, 350);
    ctx.stroke();
  },

  'dog-frisbee': (ctx) => {
    drawGradientBg(ctx, ['#87CEEB', '#98FB98', '#228B22']);
    // Park
    ctx.fillStyle = '#228B22';
    ctx.fillRect(0, 500, SIZE, 300);
    // Dog body (simplified)
    ctx.fillStyle = '#8B4513';
    // Body
    ctx.beginPath();
    ctx.ellipse(380, 420, 80, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    drawCircle(ctx, 450, 380, 30, '#8B4513');
    // Ears
    drawCircle(ctx, 435, 360, 12, '#5C3317');
    drawCircle(ctx, 465, 360, 12, '#5C3317');
    // Eye
    drawCircle(ctx, 455, 375, 5, '#FFF');
    drawCircle(ctx, 457, 375, 3, '#000');
    // Legs
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(340, 450, 12, 40);
    ctx.fillRect(410, 450, 12, 40);
    // Tail up
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(300, 420);
    ctx.quadraticCurveTo(280, 370, 290, 350);
    ctx.stroke();
    // Frisbee in air
    ctx.fillStyle = '#E74C3C';
    ctx.beginPath();
    ctx.ellipse(550, 250, 50, 12, 0.3, 0, Math.PI * 2);
    ctx.fill();
    // Trees
    drawTriangle(ctx, 100, 350, 100, '#1B7A1B');
    ctx.fillStyle = '#5C3317';
    ctx.fillRect(93, 450, 14, 50);
    drawTriangle(ctx, 700, 380, 80, '#1B7A1B');
    ctx.fillStyle = '#5C3317';
    ctx.fillRect(693, 460, 14, 40);
  },

  'dancing-rain': (ctx) => {
    drawGradientBg(ctx, ['#1a1a2e', '#16213e', '#0f3460']);
    // Wet street
    ctx.fillStyle = '#2C3E50';
    ctx.fillRect(0, 550, SIZE, 250);
    // Reflections
    for (let i = 0; i < 20; i++) {
      ctx.fillStyle = `rgba(255, 200, 100, ${randomBetween(0.05, 0.15)})`;
      ctx.fillRect(randomBetween(0, SIZE), randomBetween(560, 750), randomBetween(20, 60), randomBetween(5, 15));
    }
    // Streetlights
    for (const x of [150, 650]) {
      ctx.fillStyle = '#555';
      ctx.fillRect(x - 3, 200, 6, 350);
      drawCircle(ctx, x, 200, 25, '#FFD700');
      // Light cone
      ctx.fillStyle = 'rgba(255, 215, 0, 0.1)';
      ctx.beginPath();
      ctx.moveTo(x - 25, 200); ctx.lineTo(x - 80, 550);
      ctx.lineTo(x + 80, 550); ctx.lineTo(x + 25, 200);
      ctx.closePath();
      ctx.fill();
    }
    // Two dancing figures
    ctx.strokeStyle = '#DDD';
    ctx.lineWidth = 5;
    // Figure 1
    drawCircle(ctx, 370, 350, 18, '#DDD');
    ctx.beginPath();
    ctx.moveTo(370, 368); ctx.lineTo(370, 440);
    ctx.moveTo(370, 440); ctx.lineTo(350, 500);
    ctx.moveTo(370, 440); ctx.lineTo(400, 500);
    ctx.moveTo(370, 390); ctx.lineTo(340, 420);
    ctx.stroke();
    // Figure 2
    drawCircle(ctx, 430, 340, 18, '#DDD');
    ctx.beginPath();
    ctx.moveTo(430, 358); ctx.lineTo(430, 430);
    ctx.moveTo(430, 430); ctx.lineTo(410, 490);
    ctx.moveTo(430, 430); ctx.lineTo(460, 490);
    ctx.moveTo(430, 380); ctx.lineTo(460, 360);
    ctx.stroke();
    // Rain
    ctx.strokeStyle = 'rgba(200, 200, 255, 0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 100; i++) {
      const x = randomBetween(0, SIZE);
      const y = randomBetween(0, SIZE);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 15);
      ctx.stroke();
    }
  },

  'skateboarding': (ctx) => {
    drawGradientBg(ctx, ['#FF6B6B', '#FFA07A', '#F0E68C']);
    // Halfpipe
    ctx.fillStyle = '#808080';
    ctx.beginPath();
    ctx.moveTo(100, 600); ctx.quadraticCurveTo(400, 400, 700, 600);
    ctx.lineTo(700, 750); ctx.lineTo(100, 750);
    ctx.closePath();
    ctx.fill();
    // Skater
    ctx.strokeStyle = '#1C1C1C';
    ctx.lineWidth = 6;
    drawCircle(ctx, 400, 330, 20, '#FFD194');
    ctx.beginPath();
    ctx.moveTo(400, 350); ctx.lineTo(400, 410);
    ctx.moveTo(400, 410); ctx.lineTo(380, 460);
    ctx.moveTo(400, 410); ctx.lineTo(420, 460);
    ctx.moveTo(400, 370); ctx.lineTo(360, 350);
    ctx.moveTo(400, 370); ctx.lineTo(440, 340);
    ctx.stroke();
    // Skateboard
    ctx.fillStyle = '#8B4513';
    ctx.beginPath();
    ctx.ellipse(400, 470, 35, 6, 0.1, 0, Math.PI * 2);
    ctx.fill();
    // Wheels
    drawCircle(ctx, 375, 476, 5, '#333');
    drawCircle(ctx, 425, 476, 5, '#333');
  },

  'pizza-toss': (ctx) => {
    drawGradientBg(ctx, ['#8B4513', '#D2691E', '#F5DEB3']);
    // Kitchen background
    drawRoundedRect(ctx, 0, 600, SIZE, 200, 0, '#654321');
    // Counter
    ctx.fillStyle = '#DEB887';
    ctx.fillRect(0, 580, SIZE, 30);
    // Chef figure
    drawCircle(ctx, 350, 400, 25, '#FFD194');
    // Chef hat
    drawRoundedRect(ctx, 330, 355, 40, 30, 8, '#FFF');
    ctx.fillRect(320, 375, 60, 10);
    ctx.fillStyle = '#FFF';
    ctx.fill();
    // Body
    ctx.fillStyle = '#FFF';
    ctx.fillRect(338, 425, 24, 80);
    // Arms up
    ctx.strokeStyle = '#FFF';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(350, 440); ctx.lineTo(300, 380);
    ctx.moveTo(350, 440); ctx.lineTo(420, 350);
    ctx.stroke();
    // Pizza dough (circle in air)
    ctx.fillStyle = '#F5DEB3';
    ctx.beginPath();
    ctx.ellipse(400, 250, 80, 15, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#D2691E';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Flour particles
    for (let i = 0; i < 30; i++) {
      drawCircle(ctx, randomBetween(300, 500), randomBetween(200, 400), randomBetween(1, 4), 'rgba(255,255,255,0.5)');
    }
  },

  'hammock-reading': (ctx) => {
    drawGradientBg(ctx, ['#00BFFF', '#87CEEB', '#FFF8DC']);
    // Sand
    ctx.fillStyle = '#F4D03F';
    ctx.fillRect(0, 600, SIZE, 200);
    // Ocean
    ctx.fillStyle = '#00BFFF';
    ctx.fillRect(0, 500, SIZE, 110);
    // Palm trees
    for (const x of [150, 650]) {
      ctx.fillStyle = '#8B4513';
      ctx.save();
      ctx.translate(x, 600);
      ctx.rotate(x < 400 ? 0.15 : -0.15);
      ctx.fillRect(-8, -350, 16, 350);
      ctx.restore();
      // Leaves
      for (let i = 0; i < 5; i++) {
        const angle = -Math.PI / 2 + (i - 2) * 0.5;
        ctx.strokeStyle = '#228B22';
        ctx.lineWidth = 4;
        ctx.beginPath();
        const bx = x + (x < 400 ? 10 : -10);
        ctx.moveTo(bx, 260);
        ctx.quadraticCurveTo(
          bx + Math.cos(angle) * 80,
          260 + Math.sin(angle) * 80,
          bx + Math.cos(angle) * 120,
          260 + Math.sin(angle) * 120 + 30
        );
        ctx.stroke();
      }
    }
    // Hammock
    ctx.strokeStyle = '#E74C3C';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(170, 380);
    ctx.quadraticCurveTo(400, 480, 640, 380);
    ctx.stroke();
    // Hammock netting
    ctx.strokeStyle = 'rgba(231, 76, 60, 0.3)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      const t = (i + 1) / 11;
      const x1 = 170 + t * 470;
      ctx.beginPath();
      ctx.moveTo(x1, 380 + Math.sin(t * Math.PI) * 80);
      ctx.lineTo(x1, 380 + Math.sin(t * Math.PI) * 100 + 10);
      ctx.stroke();
    }
    // Person shape in hammock
    ctx.fillStyle = '#FFD194';
    drawCircle(ctx, 370, 430, 15, '#FFD194');
    // Book
    drawRoundedRect(ctx, 390, 445, 25, 18, 2, '#3498DB');
  },

  'street-musician': (ctx) => {
    drawGradientBg(ctx, ['#2C3E50', '#E67E22', '#F39C12']);
    // Street
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 580, SIZE, 220);
    // Building walls
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(0, 100, 200, 480);
    ctx.fillStyle = '#A0522D';
    ctx.fillRect(600, 100, 200, 480);
    // Windows
    for (const bx of [40, 120, 640, 720]) {
      for (let y = 150; y < 500; y += 100) {
        ctx.fillStyle = '#FFE4B5';
        ctx.fillRect(bx, y, 40, 50);
      }
    }
    // Musician
    drawCircle(ctx, 400, 380, 22, '#8B4513');
    // Hat
    drawRoundedRect(ctx, 375, 355, 50, 15, 4, '#1C1C1C');
    ctx.fillRect(365, 370, 70, 8);
    // Body
    ctx.fillStyle = '#2C3E50';
    ctx.fillRect(388, 402, 24, 80);
    // Saxophone
    ctx.strokeStyle = '#DAA520';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(420, 420);
    ctx.quadraticCurveTo(470, 440, 460, 500);
    ctx.quadraticCurveTo(450, 530, 430, 540);
    ctx.stroke();
    drawCircle(ctx, 425, 545, 15, '#DAA520');
    // Music notes
    drawText(ctx, '♪', 480, 350, 40, '#FFD700');
    drawText(ctx, '♫', 320, 320, 30, '#FFD700');
    drawText(ctx, '♪', 500, 300, 35, '#FFD700');
  },

  'snowball-fight': (ctx) => {
    drawGradientBg(ctx, ['#B0C4DE', '#DCDCDC', '#FFFFFF']);
    // Snow ground
    ctx.fillStyle = '#F0F0F0';
    ctx.fillRect(0, 500, SIZE, 300);
    // Trees
    for (const x of [80, 700]) {
      drawTriangle(ctx, x, 300, 80, '#2E8B57');
      drawTriangle(ctx, x, 350, 70, '#2E8B57');
      ctx.fillStyle = '#5C3317';
      ctx.fillRect(x - 6, 420, 12, 80);
      // Snow on trees
      drawCircle(ctx, x - 20, 320, 15, 'rgba(255,255,255,0.8)');
      drawCircle(ctx, x + 15, 340, 12, 'rgba(255,255,255,0.8)');
    }
    // Kid 1 (left)
    drawCircle(ctx, 280, 430, 18, '#FFD194');
    ctx.fillStyle = '#E74C3C';
    drawRoundedRect(ctx, 265, 410, 30, 12, 4, '#E74C3C');
    ctx.fillStyle = '#3498DB';
    ctx.fillRect(270, 448, 20, 50);
    // Kid 2 (right)
    drawCircle(ctx, 520, 440, 18, '#FFD194');
    drawRoundedRect(ctx, 505, 420, 30, 12, 4, '#2ECC71');
    ctx.fillStyle = '#9B59B6';
    ctx.fillRect(510, 458, 20, 50);
    // Snowballs in air
    drawCircle(ctx, 380, 380, 10, '#FFF');
    drawCircle(ctx, 420, 400, 10, '#FFF');
    drawCircle(ctx, 350, 420, 8, '#FFF');
    // Snow fort
    for (let i = 0; i < 5; i++) {
      drawCircle(ctx, 200 + i * 25, 500, 15, '#E8E8E8');
    }
    // Snowflakes
    for (let i = 0; i < 40; i++) {
      drawCircle(ctx, randomBetween(0, SIZE), randomBetween(0, 500), randomBetween(2, 5), 'rgba(255,255,255,0.7)');
    }
  },
};

// ────────────────────────────────────────────
// Scene drawing functions — EVERYDAY OBJECTS
// ────────────────────────────────────────────

const EVERYDAY_SCENES = {
  'red-sneakers': (ctx) => {
    drawGradientBg(ctx, ['#ECEFF1', '#CFD8DC', '#B0BEC5']);
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.beginPath();
    ctx.ellipse(400, 520, 180, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    // Shoe body
    ctx.fillStyle = '#E74C3C';
    ctx.beginPath();
    ctx.moveTo(220, 480); ctx.lineTo(580, 480);
    ctx.quadraticCurveTo(600, 480, 600, 460);
    ctx.lineTo(580, 380);
    ctx.quadraticCurveTo(560, 360, 500, 360);
    ctx.lineTo(300, 370);
    ctx.quadraticCurveTo(220, 380, 200, 430);
    ctx.quadraticCurveTo(195, 460, 220, 480);
    ctx.closePath();
    ctx.fill();
    // Sole
    ctx.fillStyle = '#FFF';
    ctx.fillRect(200, 475, 400, 20);
    // Laces
    ctx.strokeStyle = '#FFF';
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const x = 340 + i * 40;
      ctx.beginPath();
      ctx.moveTo(x, 370); ctx.lineTo(x + 15, 395);
      ctx.stroke();
    }
    // Nike-style swoosh
    ctx.strokeStyle = '#C0392B';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(540, 410);
    ctx.quadraticCurveTo(400, 440, 280, 410);
    ctx.stroke();
  },

  'typewriter': (ctx) => {
    drawGradientBg(ctx, ['#5D4037', '#4E342E', '#3E2723']);
    // Desk surface
    ctx.fillStyle = '#8D6E63';
    ctx.fillRect(100, 450, 600, 30);
    // Typewriter body
    drawRoundedRect(ctx, 200, 300, 400, 150, 12, '#37474F');
    // Paper
    ctx.fillStyle = '#FFFDE7';
    ctx.fillRect(300, 200, 200, 120);
    // Text on paper
    ctx.fillStyle = '#333';
    ctx.font = '10px monospace';
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(320, 220 + i * 15, randomBetween(80, 160), 2);
    }
    // Keys
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 10; col++) {
        drawCircle(ctx, 240 + col * 35, 340 + row * 35, 12, '#546E7A');
      }
    }
    // Carriage return lever
    ctx.fillStyle = '#455A64';
    ctx.fillRect(590, 310, 40, 8);
    drawCircle(ctx, 635, 314, 8, '#333');
  },

  'pancakes': (ctx) => {
    drawGradientBg(ctx, ['#FFF8E1', '#FFE082', '#FFD54F']);
    // Plate
    ctx.fillStyle = '#ECEFF1';
    ctx.beginPath();
    ctx.ellipse(400, 500, 200, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    // Pancake stack
    for (let i = 0; i < 5; i++) {
      const y = 420 - i * 30;
      ctx.fillStyle = `rgb(${210 + i * 5}, ${170 + i * 5}, ${100 + i * 10})`;
      ctx.beginPath();
      ctx.ellipse(400, y, 120 - i * 5, 25, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Butter pat on top
    drawRoundedRect(ctx, 380, 275, 40, 15, 4, '#FFF176');
    // Syrup dripping
    ctx.fillStyle = '#8D6E63';
    ctx.beginPath();
    ctx.moveTo(370, 290); ctx.quadraticCurveTo(360, 350, 340, 400);
    ctx.lineTo(350, 400); ctx.quadraticCurveTo(370, 340, 380, 290);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(430, 290); ctx.quadraticCurveTo(450, 350, 460, 420);
    ctx.lineTo(470, 420); ctx.quadraticCurveTo(460, 340, 440, 290);
    ctx.closePath();
    ctx.fill();
    // Steam
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const x = 370 + i * 30;
      ctx.beginPath();
      ctx.moveTo(x, 260);
      ctx.quadraticCurveTo(x + 10, 230, x, 200);
      ctx.quadraticCurveTo(x - 10, 170, x, 140);
      ctx.stroke();
    }
  },

  'guitar': (ctx) => {
    drawGradientBg(ctx, ['#3E2723', '#5D4037', '#795548']);
    // Brick wall
    for (let y = 0; y < SIZE; y += 40) {
      for (let x = (y / 40 % 2) * 40 - 20; x < SIZE; x += 80) {
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, 80, 40);
      }
    }
    // Guitar body
    ctx.fillStyle = '#8B4513';
    ctx.beginPath();
    ctx.ellipse(420, 500, 110, 130, 0.1, 0, Math.PI * 2);
    ctx.fill();
    // Sound hole
    drawCircle(ctx, 420, 490, 35, '#3E2723');
    // Neck
    ctx.fillStyle = '#6D4C41';
    ctx.save();
    ctx.translate(420, 500);
    ctx.rotate(-0.3);
    ctx.fillRect(-15, -400, 30, 280);
    ctx.restore();
    // Strings
    ctx.strokeStyle = '#C0C0C0';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(405 + i * 6, 380);
      ctx.lineTo(410 + i * 4, 620);
      ctx.stroke();
    }
    // Headstock
    ctx.fillStyle = '#5D4037';
    ctx.save();
    ctx.translate(340, 180);
    ctx.rotate(-0.3);
    drawRoundedRect(ctx, 0, 0, 30, 60, 8, '#5D4037');
    ctx.restore();
  },

  'rotary-phone': (ctx) => {
    drawGradientBg(ctx, ['#E0F7FA', '#B2EBF2', '#80DEEA']);
    // Table
    ctx.fillStyle = '#795548';
    ctx.fillRect(150, 550, 500, 200);
    // Phone body
    drawRoundedRect(ctx, 250, 350, 300, 200, 20, '#16A085');
    // Dial circle
    drawCircle(ctx, 400, 440, 80, '#0D7A68');
    drawCircle(ctx, 400, 440, 65, '#16A085');
    // Dial holes
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + (i / 10) * Math.PI * 1.5 + 0.3;
      const x = 400 + Math.cos(angle) * 50;
      const y = 440 + Math.sin(angle) * 50;
      drawCircle(ctx, x, y, 10, '#0D7A68');
    }
    // Handset cradle
    drawRoundedRect(ctx, 270, 340, 260, 25, 10, '#128C7E');
    // Handset
    ctx.fillStyle = '#16A085';
    drawRoundedRect(ctx, 280, 310, 80, 35, 12, '#16A085');
    ctx.fillRect(340, 320, 120, 15);
    drawRoundedRect(ctx, 440, 310, 80, 35, 12, '#16A085');
    // Cord
    ctx.strokeStyle = '#128C7E';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(400, 550);
    ctx.quadraticCurveTo(400, 620, 350, 650);
    ctx.stroke();
  },

  'hot-air-balloon': (ctx) => {
    drawGradientBg(ctx, ['#1A237E', '#3F51B5', '#9FA8DA']);
    // Sunrise glow
    drawCircle(ctx, 400, 700, 300, 'rgba(255, 193, 7, 0.15)');
    // Balloon envelope (stripes)
    const stripeColors = ['#E74C3C', '#F39C12', '#F1C40F', '#2ECC71', '#3498DB', '#9B59B6'];
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = stripeColors[i];
      ctx.beginPath();
      const startAngle = Math.PI + (i / 6) * Math.PI;
      const endAngle = Math.PI + ((i + 1) / 6) * Math.PI;
      ctx.arc(400, 320, 150, startAngle, endAngle);
      ctx.lineTo(400, 320);
      ctx.closePath();
      ctx.fill();
    }
    // Bottom of balloon
    ctx.fillStyle = '#E74C3C';
    ctx.beginPath();
    ctx.moveTo(300, 430); ctx.quadraticCurveTo(400, 520, 500, 430);
    ctx.lineTo(500, 320); ctx.lineTo(300, 320);
    ctx.closePath();
    ctx.fill();
    // Ropes
    ctx.strokeStyle = '#5D4037';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(330, 470); ctx.lineTo(360, 560);
    ctx.moveTo(470, 470); ctx.lineTo(440, 560);
    ctx.stroke();
    // Basket
    drawRoundedRect(ctx, 350, 555, 100, 60, 8, '#8D6E63');
    // Clouds
    for (let i = 0; i < 4; i++) {
      const cx = 80 + i * 220;
      drawCircle(ctx, cx, 200 + i * 60, 50, 'rgba(255,255,255,0.3)');
      drawCircle(ctx, cx + 35, 195 + i * 60, 40, 'rgba(255,255,255,0.3)');
    }
  },

  'polaroid-camera': (ctx) => {
    drawGradientBg(ctx, ['#FAFAFA', '#F5F5F5', '#EEEEEE']);
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.ellipse(400, 560, 200, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    // Camera body
    drawRoundedRect(ctx, 250, 250, 300, 260, 16, '#F5F5F5');
    ctx.strokeStyle = '#DDD';
    ctx.lineWidth = 2;
    ctx.strokeRect(252, 252, 296, 256);
    // Rainbow stripe
    const rainbow = ['#E74C3C', '#F39C12', '#F1C40F', '#2ECC71', '#3498DB'];
    rainbow.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(250, 415 + i * 8, 300, 8);
    });
    // Lens
    drawCircle(ctx, 400, 340, 60, '#333');
    drawCircle(ctx, 400, 340, 50, '#555');
    drawCircle(ctx, 400, 340, 35, '#222');
    drawCircle(ctx, 400, 340, 15, '#3498DB');
    // Flash
    drawRoundedRect(ctx, 280, 260, 50, 30, 6, '#BDBDBD');
    // Viewfinder
    drawRoundedRect(ctx, 440, 265, 40, 25, 4, '#333');
    // Scattered photos below
    for (let i = 0; i < 3; i++) {
      const x = 200 + i * 150;
      const r = (i - 1) * 0.2;
      ctx.save();
      ctx.translate(x, 620);
      ctx.rotate(r);
      ctx.fillStyle = '#FFF';
      ctx.fillRect(-40, -50, 80, 100);
      ctx.fillStyle = `hsl(${i * 120}, 50%, 70%)`;
      ctx.fillRect(-30, -40, 60, 60);
      ctx.restore();
    }
  },

  'disco-ball': (ctx) => {
    drawGradientBg(ctx, ['#0D0D0D', '#1A1A2E', '#16213e']);
    // Light beams from disco ball
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const colors = ['rgba(255,0,0,0.1)', 'rgba(0,255,0,0.1)', 'rgba(0,0,255,0.1)', 'rgba(255,255,0,0.1)'];
      ctx.fillStyle = colors[i % 4];
      ctx.beginPath();
      ctx.moveTo(400, 300);
      ctx.lineTo(400 + Math.cos(angle) * 500, 300 + Math.sin(angle) * 500);
      ctx.lineTo(400 + Math.cos(angle + 0.2) * 500, 300 + Math.sin(angle + 0.2) * 500);
      ctx.closePath();
      ctx.fill();
    }
    // String
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(400, 0); ctx.lineTo(400, 220);
    ctx.stroke();
    // Disco ball
    drawCircle(ctx, 400, 300, 80, '#C0C0C0');
    // Mirror tiles
    for (let y = -70; y < 70; y += 15) {
      for (let x = -70; x < 70; x += 15) {
        if (x * x + y * y < 5600) {
          const brightness = randomBetween(180, 255);
          ctx.fillStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
          ctx.fillRect(398 + x, 298 + y, 12, 12);
        }
      }
    }
    // Specular highlights
    drawCircle(ctx, 375, 275, 15, 'rgba(255,255,255,0.6)');
    drawCircle(ctx, 420, 310, 8, 'rgba(255,255,255,0.3)');
  },

  'school-bus': (ctx) => {
    drawGradientBg(ctx, ['#87CEEB', '#AED581', '#66BB6A']);
    // Road
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 550, SIZE, 200);
    // Trees
    for (const x of [80, 200, 600, 720]) {
      drawTriangle(ctx, x, 300, 100, '#2E7D32');
      drawTriangle(ctx, x, 350, 80, '#388E3C');
      ctx.fillStyle = '#5D4037';
      ctx.fillRect(x - 6, 430, 12, 120);
    }
    // Bus body
    drawRoundedRect(ctx, 150, 380, 500, 170, 12, '#F9A825');
    // Windows
    for (let i = 0; i < 5; i++) {
      drawRoundedRect(ctx, 220 + i * 80, 400, 55, 50, 6, '#B3E5FC');
    }
    // Windshield
    drawRoundedRect(ctx, 560, 395, 75, 80, 6, '#B3E5FC');
    // Wheels
    drawCircle(ctx, 250, 555, 35, '#333');
    drawCircle(ctx, 250, 555, 20, '#666');
    drawCircle(ctx, 540, 555, 35, '#333');
    drawCircle(ctx, 540, 555, 20, '#666');
    // STOP sign
    drawRoundedRect(ctx, 130, 400, 25, 50, 2, '#E74C3C');
    // Front bumper
    ctx.fillStyle = '#333';
    ctx.fillRect(145, 545, 510, 8);
    // Headlights
    drawCircle(ctx, 640, 500, 12, '#FFF9C4');
    drawCircle(ctx, 640, 530, 12, '#EF5350');
  },

  'rubiks-cube': (ctx) => {
    drawGradientBg(ctx, ['#263238', '#37474F', '#455A64']);
    // Reflective surface
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 550, SIZE, 250);
    // Cube face — front (3x3 grid)
    const faceX = 220, faceY = 220, cellSize = 80, gap = 4;
    const frontColors = [
      ['#E74C3C', '#FFF', '#3498DB'],
      ['#F39C12', '#E74C3C', '#FFF'],
      ['#2ECC71', '#F39C12', '#E74C3C'],
    ];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        drawRoundedRect(ctx,
          faceX + c * (cellSize + gap),
          faceY + r * (cellSize + gap),
          cellSize, cellSize, 6,
          frontColors[r][c]
        );
      }
    }
    // Top face (parallelogram) — simplified as rectangles with transform
    const topColors = ['#FFF', '#F1C40F', '#2ECC71'];
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = topColors[c];
      const x = faceX + c * (cellSize + gap) + 30;
      ctx.beginPath();
      ctx.moveTo(x, faceY - 5);
      ctx.lineTo(x + cellSize, faceY - 5);
      ctx.lineTo(x + cellSize - 30, faceY - 55);
      ctx.lineTo(x - 30, faceY - 55);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Right face
    const rightColors = ['#3498DB', '#F39C12', '#2ECC71'];
    for (let r = 0; r < 3; r++) {
      ctx.fillStyle = rightColors[r];
      const y = faceY + r * (cellSize + gap);
      const x = faceX + 3 * (cellSize + gap) - gap;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + cellSize);
      ctx.lineTo(x + 50, y + cellSize - 30);
      ctx.lineTo(x + 50, y - 30);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Reflection
    ctx.globalAlpha = 0.15;
    ctx.save();
    ctx.translate(0, 1100);
    ctx.scale(1, -1);
    // Redraw front face reflection
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        drawRoundedRect(ctx, faceX + c * (cellSize + gap), faceY + r * (cellSize + gap), cellSize, cellSize, 6, frontColors[r][c]);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },
};

// ────────────────────────────────────────────
// File mapping
// ────────────────────────────────────────────

const ALL_SCENES = {
  landmarks: {
    scenes: LANDMARK_SCENES,
    files: {
      'eiffel-tower': 'eiffel-tower.png',
      'great-wall': 'great-wall.png',
      'statue-of-liberty': 'statue-of-liberty.png',
      'taj-mahal': 'taj-mahal.png',
      'colosseum': 'colosseum.png',
      'machu-picchu': 'machu-picchu.png',
      'sydney-opera-house': 'sydney-opera-house.png',
      'big-ben': 'big-ben.png',
      'christ-redeemer': 'christ-redeemer.png',
      'golden-gate': 'golden-gate.png',
    },
  },
  'whats-happening': {
    scenes: WHATS_HAPPENING_SCENES,
    files: {
      'man-on-bike': 'man-on-bike.png',
      'woman-jumping': 'woman-jumping.png',
      'kid-kite': 'kid-kite.png',
      'dog-frisbee': 'dog-frisbee.png',
      'dancing-rain': 'dancing-rain.png',
      'skateboarding': 'skateboarding.png',
      'pizza-toss': 'pizza-toss.png',
      'hammock-reading': 'hammock-reading.png',
      'street-musician': 'street-musician.png',
      'snowball-fight': 'snowball-fight.png',
    },
  },
  'everyday-objects': {
    scenes: EVERYDAY_SCENES,
    files: {
      'red-sneakers': 'red-sneakers.png',
      'typewriter': 'typewriter.png',
      'pancakes': 'pancakes.png',
      'guitar': 'guitar.png',
      'rotary-phone': 'rotary-phone.png',
      'hot-air-balloon': 'hot-air-balloon.png',
      'polaroid-camera': 'polaroid-camera.png',
      'disco-ball': 'disco-ball.png',
      'school-bus': 'school-bus.png',
      'rubiks-cube': 'rubiks-cube.png',
    },
  },
};

// ────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

// ────────────────────────────────────────────
// Generate images
// ────────────────────────────────────────────

function main() {
  const listMode = args.includes('--list');
  const categoryFilter = getArg('--category');

  const categoriesToGenerate = categoryFilter
    ? { [categoryFilter]: ALL_SCENES[categoryFilter] }
    : ALL_SCENES;

  if (categoryFilter && !ALL_SCENES[categoryFilter]) {
    console.error(`\n  Unknown category: "${categoryFilter}"`);
    console.error(`  Available: ${Object.keys(ALL_SCENES).join(', ')}\n`);
    process.exit(1);
  }

  let totalGenerated = 0;

  for (const [catId, { scenes, files }] of Object.entries(categoriesToGenerate)) {
    const catDir = path.join(ASSETS_DIR, catId);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    console.log(`\n  ┌─ ${catId.toUpperCase()}`);

    for (const [sceneId, drawFn] of Object.entries(scenes)) {
      const filename = files[sceneId];
      const filePath = path.join(catDir, filename);

      if (listMode) {
        console.log(`  │  ${filename}`);
        continue;
      }

      if (fs.existsSync(filePath)) {
        console.log(`  │  SKIP  ${filename} (exists)`);
        continue;
      }

      const canvas = createCanvas(SIZE, SIZE);
      const ctx = canvas.getContext('2d');
      drawFn(ctx);

      const buffer = canvas.toBuffer('image/png');
      fs.writeFileSync(filePath, buffer);
      totalGenerated++;
      console.log(`  │  GEN   ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
    }

    console.log(`  └─ done`);
  }

  if (!listMode) {
    console.log(`\n  ✓ ${totalGenerated} images generated in ${ASSETS_DIR}`);
    if (totalGenerated > 0) {
      console.log(`\n  NEXT: Update categories.js to wire them in.`);
      console.log(`  Example: image: require('../../assets/images/landmarks/eiffel-tower.png')\n`);
    }
  }
}

main();
