const vscode = acquireVsCodeApi();

// --- State Management ---
let pendingOriginElement = null;
let activeConnections = []; 

// --- Initialization & Event Listeners ---
window.addEventListener('message', handleMessage);
// document.getElementById('graph-wrapper').addEventListener('scroll', redrawLines);
// --- Canvas & Drag State ---
let currentScale = 1;
let canvasX = 0, canvasY = 0;

let draggedElement = null; // Tracks if we are dragging 'canvas' or a specific card
let dragStartX = 0, dragStartY = 0;

// --- Initialization ---
window.addEventListener('message', handleMessage);

// Wait for DOM to load before attaching viewport events
document.addEventListener("DOMContentLoaded", () => {
    const viewport = document.getElementById('viewport');
    const canvas = document.getElementById('canvas');

    // Mouse Wheel Zooming
    viewport.addEventListener('wheel', viewportMouseWheelZoom);
    // Mouse Down (Start Dragging)
    viewport.addEventListener('mousedown', viewportMouseDown);
    // aux click (middle clicks)
    // viewport.addEventListener('auxclick', viewportMouseAuxClick);
    // Mouse Move (Dragging)
    window.addEventListener('mousemove', viewportMouseMove);
    // Mouse Up (Stop Dragging)
    window.addEventListener('mouseup', () => {
        draggedElement = null;
    });

});

// Global function for the badge HTML onclick events
window.jumpToLocation = function(fullUri, line) {
    vscode.postMessage({
        command: 'jumpTo',
        fullUri: fullUri,
        line: line
    });
};

// panning functions
function updateCanvasTransform() {
    canvas.style.transform = `translate(${canvasX}px, ${canvasY}px) scale(${currentScale})`;
    // SVG lines naturally move with the canvas, no redraw needed for canvas pan/zoom!
}

function viewportMouseWheelZoom(e) {
    const zoomDirection = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.min(Math.max(0.2, currentScale + zoomDirection), 3); // Restrict zoom 20% to 300%
    
    // Zoom towards mouse cursor math
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const canvasMouseX = (mouseX - canvasX) / currentScale;
    const canvasMouseY = (mouseY - canvasY) / currentScale;
    
    currentScale = newScale;
    canvasX = mouseX - (canvasMouseX * currentScale);
    canvasY = mouseY - (canvasMouseY * currentScale);
    
    updateCanvasTransform();
}

function viewportMouseDown(e) {

    const cardHandle = e.target.closest('.node-symbol');
    
    if (cardHandle) {
        // Dragging a specific card
        draggedElement = cardHandle.closest('.node-card');
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        
        // Initialize transform offsets if they don't exist
        if (!draggedElement.dataset.x) draggedElement.dataset.x = 0;
        if (!draggedElement.dataset.y) draggedElement.dataset.y = 0;
    } else if (e.button === 1) {
        // event.button === 1 indicates the middle mouse button
        // Dragging the background canvas
        e.preventDefault(); // Stop Windows from opening the auto-scroll compass
        draggedElement = 'canvas';
        dragStartX = e.clientX - canvasX;
        dragStartY = e.clientY - canvasY;
    }
    else if (e.button === 0 && !e.target.closest('.node-card')) {
        // maybe some other code can be add back here if needed
    }
}

function viewportMouseMove(e) {
    if (!draggedElement) return;

    if (draggedElement === 'canvas') {
        canvasX = e.clientX - dragStartX;
        canvasY = e.clientY - dragStartY;
        updateCanvasTransform();
    } else {
        // Dragging a card (divide by scale so mouse perfectly tracks the card)
        const dx = (e.clientX - dragStartX) / currentScale;
        const dy = (e.clientY - dragStartY) / currentScale;
        
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const newX = parseFloat(draggedElement.dataset.x) + dx;
        const newY = parseFloat(draggedElement.dataset.y) + dy;
        
        draggedElement.dataset.x = newX;
        draggedElement.dataset.y = newY;
        draggedElement.style.transform = `translate(${newX}px, ${newY}px)`;
        
        redrawLines(); // instantly redraw lines as the card moves
    }
}


// --- Core Functions ---

function handleMessage(event) {
    const message = event.data; 
    if (message.command === 'addNode') {
        addNodeToGraph(message.data);
    }
}

function addNodeToGraph(data) {
    const container = document.getElementById('graph-container');
    if (container.querySelector('p')) container.innerHTML = ''; 

    // Clone the Node Template
    const nodeTemplate = document.getElementById('node-template');
    const nodeClone = nodeTemplate.content.cloneNode(true);
    const newCardElement = nodeClone.querySelector('.node-card');

    // Populate the Node Data
    newCardElement.querySelector('.node-symbol').textContent = data.symbolName;
    newCardElement.querySelector('.node-file').innerHTML = `Defined in: <b>${data.fileName}</b> : ${data.line}`;
    
    const codeEl = newCardElement.querySelector('.node-code');
    codeEl.className = `language-${data.fileExt}`;
    codeEl.textContent = data.code;

    // Attach Interactive Code Listener
    codeEl.addEventListener('dblclick', handleCodeDoubleClick);

    // Handle References
    newCardElement.querySelector('.node-refs-title').innerHTML = `<strong>Used ${data.references.length} time(s):</strong>`;
    const refsContainer = newCardElement.querySelector('.node-refs-container');

    if (data.references.length > 0) {
        const badgeTemplate = document.getElementById('badge-template');
        data.references.forEach(r => {
            const badgeClone = badgeTemplate.content.cloneNode(true);
            const badgeEl = badgeClone.querySelector('.ref-badge');
            badgeEl.textContent = `${r.file} : ${r.line}`;
            badgeEl.onclick = () => window.jumpToLocation(r.fullUri, r.line);
            refsContainer.appendChild(badgeClone);
        });
    } else {
        refsContainer.innerHTML = '<span style="opacity: 0.6; font-size: 0.85em; font-style: italic;">No other references found in this workspace.</span>';
    }

    // Handle Close Button
    const closeBtn = newCardElement.querySelector('.close-card');
    if (closeBtn) {
        closeBtn.onclick = () => {
            // 1. Find the connection tied to this card before we delete it
            const connToRemove = activeConnections.find(c => c.endCard === newCardElement);
            
            // 2. Unwrap the specific highlighted word so it returns to normal text
            if (connToRemove && connToRemove.startEl && connToRemove.startEl.parentNode) {
                const el = connToRemove.startEl;
                const parent = el.parentNode;
                while (el.firstChild) parent.insertBefore(el.firstChild, el);
                parent.removeChild(el);
            }

            // 3. Remove the card and filter connections
            newCardElement.remove();
            activeConnections = activeConnections.filter(c => document.body.contains(c.startEl) && document.body.contains(c.endCard));
            
            // 4. Redraw the remaining lines
            redrawLines();
        };
    }

    // Determine Placement (Aligned with the clicked word)
    let spawnX = 40;
    let spawnY = 40;

    if (pendingOriginElement) {
        const canvasRect = document.getElementById('canvas').getBoundingClientRect();
        
        // 1. Find the exact Y position of the word you clicked
        const wordRect = pendingOriginElement.getBoundingClientRect();
        const exactY = (wordRect.top - canvasRect.top) / currentScale;
        
        // 2. Find the exact right edge of the parent card
        const parentCard = pendingOriginElement.closest('.node-card');
        const parentRect = parentCard.getBoundingClientRect();
        const exactRightEdge = (parentRect.right - canvasRect.left) / currentScale;

        // 3. Spawn directly to the right, aligning the card's title with the word!
        spawnX = exactRightEdge + 80;
        spawnY = exactY - 20; // Shift up slightly so the title visually centers on the line

        // Stagger effect: If you spawn multiple dependencies from the exact same line, stack them
        while (document.querySelector(`.node-card[data-x="${spawnX}"][data-y="${spawnY}"]`)) {
            spawnY += 60; 
        }
    }

    // Apply coordinates immediately before appending
    newCardElement.dataset.x = spawnX;
    newCardElement.dataset.y = spawnY;
    newCardElement.style.transform = `translate(${spawnX}px, ${spawnY}px)`;

    // Mount directly to the graph container
    container.appendChild(nodeClone);
    
    if (pendingOriginElement) {
        activeConnections.push({
            startEl: pendingOriginElement,
            endCard: newCardElement
        });
        pendingOriginElement = null; 
    }

    hljs.highlightElement(codeEl);
    
    // Ensure the DOM has physically painted the new card before drawing the lines
    setTimeout(redrawLines, 10);
}

function getOrCreateColumn(container, level) {
    let col = document.querySelector(`.level-column[data-level="${level}"]`);
    if (!col) {
        col = document.createElement('div');
        col.className = 'level-column';
        col.dataset.level = level;
        container.appendChild(col);
    }
    return col;
}

function handleCodeDoubleClick(event) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (selectedText && /^[a-zA-Z0-9_]+$/.test(selectedText)) {
        const range = selection.getRangeAt(0);
        
        // Prevent infinite nesting if the user double-clicks an already highlighted word
        if (range.commonAncestorContainer.parentNode && 
            range.commonAncestorContainer.parentNode.classList && 
            range.commonAncestorContainer.parentNode.classList.contains('active-origin')) {
            
            pendingOriginElement = range.commonAncestorContainer.parentNode;
        } else {
            // Create a new highlight anchor and leave the old ones alone!
            const highlightNode = document.createElement('span');
            highlightNode.className = 'active-origin';
            range.surroundContents(highlightNode);
            pendingOriginElement = highlightNode;
        }
        
        selection.removeAllRanges();
        
        vscode.postMessage({
            command: 'searchSymbol',
            symbolName: selectedText
        });
    }
}

function redrawLines() {
    const svg = document.getElementById('svg-layer');
    svg.innerHTML = ''; 
    
    const canvas = document.getElementById('canvas');
    const canvasRect = canvas.getBoundingClientRect(); // scaled coordinates

    activeConnections.forEach(conn => {
        if (!document.body.contains(conn.startEl) || !document.body.contains(conn.endCard)) return;

        const startRect = conn.startEl.getBoundingClientRect();
        const endRect = conn.endCard.getBoundingClientRect();

        // Calculate coordinates relative to the un-scaled canvas origin
        const startX = (startRect.right - canvasRect.left) / currentScale;
        const startY = (startRect.top + (startRect.height / 2) - canvasRect.top) / currentScale;
        
        const endX = (endRect.left - canvasRect.left) / currentScale;
        const endY = (endRect.top + 30 - canvasRect.top) / currentScale; 

        const curveOffset = Math.abs(endX - startX) * 0.4;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const d = `M ${startX} ${startY} C ${startX + curveOffset} ${startY}, ${endX - curveOffset} ${endY}, ${endX} ${endY}`;
        
        path.setAttribute("d", d);
        path.classList.add("zoom-line"); 
        svg.appendChild(path);
    });
}