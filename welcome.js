async function cargarNoticias() {
    const contenedor = document.getElementById('noticias-container');
    
    // Esperamos hasta 5 segundos a que las noticias estén disponibles
    let intentos = 0;
    const maxIntentos = 50; // 50 * 100ms = 5 segundos
    
    while (intentos < maxIntentos) {
        const data = await chrome.storage.local.get('noticias');
        
        if (data.noticias && data.noticias.length > 0) {
            // ¡Encontramos las noticias! Las mostramos
            contenedor.innerHTML = '';
            
            data.noticias.forEach(noticia => {
                const card = document.createElement('div');
                card.className = 'noticia-card';
                const contenidoHTML = noticia.contenido.replace(/\n/g, '<br>');
                card.innerHTML = `<h3>${noticia.titulo}</h3><p>${contenidoHTML}</p>`;
                contenedor.appendChild(card);
            });
            
            return; // Salimos del bucle
        }
        
        // Esperamos 100ms y reintentamos
        await new Promise(resolve => setTimeout(resolve, 100));
        intentos++;
    }
    
    // Si después de 5 segundos no hay noticias, mostramos mensaje
    contenedor.innerHTML = '<p style="text-align: center; color: #a0a0a0; padding: 20px;">No hay noticias disponibles en este momento.</p>';
}

function parsearMarkdown(md) {
    const bloques = md.split(/^# /m).filter(b => b.trim());
    return bloques.map(bloque => {
        const lineas = bloque.split('\n');
        const titulo = lineas[0].trim();
        let contenido = lineas.slice(1).join('\n').trim();
        
        // Convertir ![alt](url) en <img>
        contenido = contenido.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            return `<img src="${url}" alt="${alt}" style="max-width: 100%; border-radius: 8px; margin: 10px 0;">`;
        });
        
        // Convertir saltos de línea en <br>
        contenido = contenido.replace(/\n/g, '<br>');
        
        return { id: titulo, titulo: titulo, contenido: contenido };
    });
}

// Iniciamos la carga
cargarNoticias();