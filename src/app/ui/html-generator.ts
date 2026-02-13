// HTML template generator for overlay window
let currentChatFontSize = 23; // Default font size

export function setChatFontSize(fontSize: number): void {
  currentChatFontSize = fontSize;
}

export function getChatFontSize(): number {
  return currentChatFontSize;
}

export function generateOverlayHTML(chatTitle: string, regionElements: string): string {
  return `
    <head>
      <title>merchant-tool</title>
      <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap" rel="stylesheet">
      <style>
        * { font-family: 'Lora', serif; word-spacing: 3px; }
        .resize-handle { position: absolute; width: 10px; height: 10px; cursor: nwse-resize; }
      </style>
    </head>
    <body style="padding: 0; margin: 0;">
      ${regionElements}
      <script>
        const electron = require('electron');
        const chatTitle = "${chatTitle}";
        let currentEditMode = false;
        let activeRegion = null;

        function formatBountyName(key) {
          // Convert SNAKE_CASE to Title Case with spaces
          return key.split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        }
        
        function formatBountyWithRarity(key, rarity) {
          const name = formatBountyName(key);
          if (!rarity) return name;
          
          const rarityText = rarity.charAt(0).toUpperCase() + rarity.slice(1);
          return name + ' (' + rarityText + ')';
        }

        function updateOverlays(ocrData) {
          // Check if we have optimal bounties
          const isOptimal = ocrData.status === 'optimal';
          
          document.querySelectorAll('[id^="activeBountyRegion"], [id^="boardRegion"], [id^="bountyBoardTitleRegion"]').forEach(region => {
            if(!region.getAttribute('data-original-bg')) {
              region.setAttribute('data-original-bg', region.style.background);
            }

            let shouldShow = false;
            let overlayHTML = "";
            let isActiveBounty = false;
            let isDrop = false;
            let isAccept = false;
            let isCalculating = false;
            if(region.id.startsWith("activeBountyRegion")) {
              const index = parseInt(region.id.replace("activeBountyRegion", ""));
              if(ocrData.activeDrops && ocrData.activeDrops.indexOf(index) !== -1) {
                shouldShow = true;
                isActiveBounty = true;
                isDrop = true;
                const bountyKey = ocrData.activeBounties && ocrData.activeBounties[index];
                const rarity = ocrData.activeBountyRarities && ocrData.activeBountyRarities[index];
                const bountyName = bountyKey ? formatBountyWithRarity(bountyKey, rarity) : '';
                overlayHTML = '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;"><div style="font-size:32px; font-weight:bold; color:rgb(231,76,60);">DROP</div>' + (bountyName ? '<div style="font-size:11px; color:white; background:black; padding:2px 6px; border-radius:3px; margin-top:4px;">' + bountyName + '</div>' : '') + '</div>';
              } else if (ocrData.activeBountyIndices && ocrData.activeBountyIndices.indexOf(index) !== -1) {
                shouldShow = true;
                isActiveBounty = true;
                const bountyKey = ocrData.activeBounties && ocrData.activeBounties[index];
                const rarity = ocrData.activeBountyRarities && ocrData.activeBountyRarities[index];
                const bountyName = bountyKey ? formatBountyWithRarity(bountyKey, rarity) : '';
                overlayHTML = '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;"><div style="font-size:28px;">👁️</div>' + (bountyName ? '<div style="font-size:11px; color:white; background:black; padding:2px 6px; border-radius:3px; margin-top:4px;">' + bountyName + '</div>' : '') + '</div>';
              }
            } else if(region.id.startsWith("boardRegion")) {
              const index = parseInt(region.id.replace("boardRegion", ""));
              // Show "Calculating..." on board regions when computing
              if(ocrData.boardOpen && ocrData.status === 'computing' && ocrData.boardBountyIndices && ocrData.boardBountyIndices.indexOf(index) !== -1) {
                shouldShow = true;
                isCalculating = true;
                const bountyKey = ocrData.boardBounties && ocrData.boardBounties[index];
                const rarity = ocrData.boardBountyRarities && ocrData.boardBountyRarities[index];
                const bountyName = bountyKey ? formatBountyWithRarity(bountyKey, rarity) : '';
                overlayHTML = '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;"><div style="font-size:32px; font-weight:bold; color:rgb(150,150,150);">CALCULATING</div>' + (bountyName ? '<div style="font-size:11px; color:white; background:black; padding:2px 6px; border-radius:3px; margin-top:4px;">' + bountyName + '</div>' : '') + '</div>';
              } else if(ocrData.boardPickups && ocrData.boardPickups.indexOf(index) !== -1) {
                shouldShow = true;
                isAccept = true;
                const bountyKey = ocrData.boardBounties && ocrData.boardBounties[index];
                const rarity = ocrData.boardBountyRarities && ocrData.boardBountyRarities[index];
                const bountyName = bountyKey ? formatBountyWithRarity(bountyKey, rarity) : '';
                overlayHTML = '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;"><div style="font-size:32px; font-weight:bold; color:rgb(46,204,113);">ACCEPT</div>' + (bountyName ? '<div style="font-size:11px; color:white; background:black; padding:2px 6px; border-radius:3px; margin-top:4px;">' + bountyName + '</div>' : '') + '</div>';
              } else if (ocrData.boardBountyIndices && ocrData.boardBountyIndices.indexOf(index) !== -1) {
                shouldShow = true;
                const bountyKey = ocrData.boardBounties && ocrData.boardBounties[index];
                const rarity = ocrData.boardBountyRarities && ocrData.boardBountyRarities[index];
                const bountyName = bountyKey ? formatBountyWithRarity(bountyKey, rarity) : '';
                overlayHTML = '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;"><div style="font-size:28px;">👁️</div>' + (bountyName ? '<div style="font-size:11px; color:white; background:black; padding:2px 6px; border-radius:3px; margin-top:4px;">' + bountyName + '</div>' : '') + '</div>';
              }
            }

            if(shouldShow) {
              if(region.children[0]) region.children[0].style.display = 'none';
              const resizeHandle = region.querySelector('.resize-handle');
              if(resizeHandle) resizeHandle.style.display = 'none';
              const actionLabel = region.querySelector('.action-label');
              if(actionLabel) actionLabel.innerHTML = overlayHTML;

              if(overlayHTML.indexOf("DROP") !== -1 || overlayHTML.indexOf("ACCEPT") !== -1 || overlayHTML.indexOf("CALCULATING") !== -1) {
                region.style.background = region.getAttribute('data-original-bg');
              } else {
                region.style.background = 'transparent';
              }
              
              // Add glowing border based on action type
              if(isDrop) {
                // Red glowing border for DROP
                region.style.boxShadow = '0 0 4px 1px rgba(231, 76, 60, 0.5)';
                region.style.border = '1px solid rgb(231, 76, 60)';
              } else if(isAccept) {
                // Green glowing border for ACCEPT
                region.style.boxShadow = '0 0 4px 1px rgba(46, 204, 113, 0.5)';
                region.style.border = '1px solid rgb(46, 204, 113)';
              } else if(isCalculating) {
                // Grey glowing border for CALCULATING
                region.style.boxShadow = '0 0 4px 1px rgba(150, 150, 150, 0.5)';
                region.style.border = '1px solid rgb(150, 150, 150)';
              } else if(isActiveBounty && isOptimal && ocrData.boardOpen) {
                // Green glowing border for active bounties when optimal (only when board is open)
                region.style.boxShadow = '0 0 4px 1px rgba(46, 204, 113, 0.5)';
                region.style.border = '1px solid rgb(46, 204, 113)';
              } else {
                region.style.boxShadow = '';
                region.style.border = '';
              }
              
              region.style.display = 'flex';
            } else {
              if(region.children[0]) region.children[0].style.display = '';
              const resizeHandle = region.querySelector('.resize-handle');
              if(resizeHandle) resizeHandle.style.display = '';
              const actionLabel = region.querySelector('.action-label');
              if(actionLabel) actionLabel.innerHTML = "";
              region.style.display = 'none';
              region.style.boxShadow = '';
              region.style.border = '';
            }
          });

          const chatRegion = document.getElementById('chatRegion');
          if (chatRegion) {
            const text = ocrData.steps || "";
            
            // Split by <br> tags to preserve them
            const parts = text.split('<br>');
            let fullFormattedText = '';
            
            for (let partIdx = 0; partIdx < parts.length; partIdx++) {
              const part = parts[partIdx];
              const chunkSize = 150, permittedOverflow = 40;
              let formattedText = '', i = 0;
              
              while (i < part.length) {
                if (i + chunkSize >= part.length) {
                  formattedText += part.substring(i);
                  break;
                }
                const minIndex = i + chunkSize;
                const maxForwardIndex = i + chunkSize + permittedOverflow;
                let forwardArrow = part.indexOf("→", minIndex);
                let breakIndex;
                if (forwardArrow !== -1 && forwardArrow <= maxForwardIndex) {
                  breakIndex = forwardArrow + 2;
                } else if (forwardArrow !== -1 && forwardArrow > maxForwardIndex) {
                  let backwardArrow = part.lastIndexOf("→", minIndex);
                  breakIndex = backwardArrow !== -1 ? backwardArrow + 2 : minIndex;
                } else {
                  let backwardArrow = part.lastIndexOf("→", minIndex);
                  breakIndex = backwardArrow !== -1 ? backwardArrow + 2 : minIndex;
                }
                formattedText += part.substring(i, breakIndex) + '<br>';
                i = breakIndex;
              }
              
              fullFormattedText += formattedText;
              if (partIdx < parts.length - 1) {
                fullFormattedText += '<br>';
              }
            }
            
            // Preserve resize handle when updating content (hidden when not in edit mode)
            chatRegion.innerHTML = \`<p style="color: white; font-size: \${window.chatFontSize || 23}px; white-space: pre-wrap; line-height: 160%;">\${fullFormattedText}</p>\`;
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.style.cssText = 'position: absolute; right: 0; bottom: 0; width: 25px; height: 25px; background: rgba(42, 42, 42, 0.9); cursor: nwse-resize; display: none;';
            chatRegion.appendChild(handle);
          }
        }

        // Initialize chat font size
        window.chatFontSize = ${currentChatFontSize};

        electron.ipcRenderer.on('chat-font-size-update', (e, fontSize) => {
          window.chatFontSize = fontSize;
          // Re-render chat if we have current data
          const chatRegion = document.getElementById('chatRegion');
          if (chatRegion && chatRegion.querySelector('p')) {
            const p = chatRegion.querySelector('p');
            if (p) {
              p.style.fontSize = fontSize + 'px';
            }
          }
        });

        electron.ipcRenderer.on('edit-mode-change', (e, editMode, ocrData) => {
          currentEditMode = editMode;
          if(editMode) {
            document.querySelectorAll('[id^="activeBountyRegion"], [id^="boardRegion"], [id^="bountyBoardTitleRegion"]').forEach(region => {
              region.style.display = 'flex';
              if(region.children[0]) region.children[0].style.display = '';
              const resizeHandle = region.querySelector('.resize-handle');
              if(resizeHandle) resizeHandle.style.display = '';
              const actionLabel = region.querySelector('.action-label');
              if(actionLabel) actionLabel.innerHTML = "";
              if(region.getAttribute('data-original-bg')) {
                region.style.background = region.getAttribute('data-original-bg');
              }
            });
            const chatRegion = document.getElementById('chatRegion');
            if(chatRegion) {
              chatRegion.innerHTML = \`<span>\${chatTitle}</span>\`;
              // Add and show resize handle in edit mode
              const handle = document.createElement('div');
              handle.className = 'resize-handle';
              handle.style.cssText = 'position: absolute; right: 0; bottom: 0; width: 25px; height: 25px; background: rgba(42, 42, 42, 0.9); cursor: nwse-resize;';
              chatRegion.appendChild(handle);
            }
          } else {
            updateOverlays(ocrData || {});
          }
        });

        electron.ipcRenderer.on('ocr-data-update', (e, ocrData) => {
          if(!currentEditMode) { 
            updateOverlays(ocrData || {}); 
          }
        });

        let overlayVisible = true;
        electron.ipcRenderer.on('visibility-change', (e, visible) => {
          overlayVisible = !overlayVisible;
          document.body.style.visibility = overlayVisible ? 'visible' : 'hidden';
        });

        electron.ipcRenderer.on('regions-update', (e, regions) => {
          for (const [id, region] of Object.entries(regions)) {
            const el = document.getElementById(id);
            if (el) {
              el.style.left = region.x + 'px';
              el.style.top = region.y + 'px';
              el.style.width = region.width + 'px';
              el.style.height = region.height + 'px';
            }
          }
        });

        document.addEventListener('mousedown', (event) => {
          if(!currentEditMode) return;
          activeRegion = event.target.closest('div[id]');
          if (!activeRegion) return;
          if(event.target.classList.contains('resize-handle')) {
            activeRegion.isResizing = true;
            activeRegion.startX = event.clientX;
            activeRegion.startY = event.clientY;
            activeRegion.startWidth = activeRegion.offsetWidth;
            activeRegion.startHeight = activeRegion.offsetHeight;
          } else {
            activeRegion.isDragging = true;
            activeRegion.startX = event.clientX - activeRegion.offsetLeft;
            activeRegion.startY = event.clientY - activeRegion.offsetTop;
          }
        });

        document.addEventListener('mousemove', (event) => {
          if (!activeRegion) return;
          if(activeRegion.isDragging) {
            activeRegion.style.left = (event.clientX - activeRegion.startX) + 'px';
            activeRegion.style.top = (event.clientY - activeRegion.startY) + 'px';
          } else if(activeRegion.isResizing) {
            activeRegion.style.width = (activeRegion.startWidth + (event.clientX - activeRegion.startX)) + 'px';
            activeRegion.style.height = (activeRegion.startHeight + (event.clientY - activeRegion.startY)) + 'px';
          }
        });

        document.addEventListener('mouseup', () => {
          if(!activeRegion) return;
          electron.ipcRenderer.send('update-region', {
            id: activeRegion.id,
            x: activeRegion.offsetLeft,
            y: activeRegion.offsetTop,
            width: activeRegion.offsetWidth,
            height: activeRegion.offsetHeight
          });
          activeRegion.isDragging = false;
          activeRegion.isResizing = false;
          activeRegion = null;
        });
      </script>
    </body>
  `;
}
