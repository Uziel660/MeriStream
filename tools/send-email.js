/**
 * Script para enviar notificaciones y reportes por correo usando FormSubmit.
 * 
 * Uso desde la terminal:
 * node tools/send-email.js "Nombre / Asunto" "Cuerpo del mensaje detallado"
 * 
 * Ejemplo:
 * node tools/send-email.js "Claude Code Agent" "VALIDACION QA FINAL Completada con éxito."
 */

const args = process.argv.slice(2);
const name = args[0] || "Agente IA";
const message = args[1];

if (!message) {
    console.error("❌ Error: Falta el mensaje a enviar.");
    console.error('Uso correcto: node tools/send-email.js "Asunto o Remitente" "Tu mensaje aquí"');
    process.exit(1);
}

// Reemplaza "tu-correo@gmail.com" con tu dirección de correo electrónico real.
// La primera vez que envíes un correo, FormSubmit te pedirá verificar tu dirección.
const correoDestino = "tu-correo@gmail.com"; 
const url = `https://formsubmit.co/ajax/${correoDestino}`;

const datosFormulario = {
    name: name,
    message: message
};

console.log(`Enviando correo a ${correoDestino}...`);

fetch(url, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
    },
    body: JSON.stringify(datosFormulario)
})
.then(response => response.json())
.then(data => {
    if (data.success === 'true' || data.success === true) {
        console.log("✅ Correo enviado con éxito!");
    } else {
        console.log("⚠️ Correo enviado, pero con respuesta inesperada:", data);
    }
})
.catch(error => {
    console.error("❌ Error al enviar el correo:", error);
    process.exit(1);
});
