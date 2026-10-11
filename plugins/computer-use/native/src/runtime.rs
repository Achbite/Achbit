use objc2::{class, msg_send, runtime::AnyObject};
use serde_json::{json, Value};
use std::{
    ffi::c_void,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    sync::atomic::{AtomicU64, Ordering},
};

static RESOURCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct MainThread {
    instance: String,
}

extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

extern "C" fn invoke(context: *mut c_void) {
    let work = unsafe { Box::from_raw(context.cast::<Box<dyn FnOnce() + Send>>()) };
    objc2::rc::autoreleasepool(|_| work());
}

impl MainThread {
    pub fn run_on_main_thread(&self, work: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let work: Box<Box<dyn FnOnce() + Send>> = Box::new(Box::new(work));
        unsafe {
            dispatch_async_f(
                &raw const _dispatch_main_q,
                Box::into_raw(work).cast(),
                invoke,
            )
        };
        Ok(())
    }

    pub fn resource_id(&self) -> String {
        format!(
            "computer-{}-{}",
            self.instance,
            RESOURCE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
    }
}

pub fn run() -> Result<(), String> {
    let arguments: Vec<_> = std::env::args().collect();
    if arguments.len() != 7
        || arguments[1] != "--connect"
        || arguments[3] != "--token"
        || arguments[5] != "--host"
    {
        return Err("Launch this component through the DeepCode GUI Host.".into());
    }
    let endpoint: std::net::SocketAddr =
        arguments[2].parse().map_err(|_| "Invalid Host endpoint")?;
    if !endpoint.ip().is_loopback() {
        return Err("Host endpoint must be local".into());
    }
    let mut stream = TcpStream::connect_timeout(&endpoint, std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    writeln!(
        stream,
        "{}",
        json!({"token":arguments[4],"pid":std::process::id()})
    )
    .map_err(|e| e.to_string())?;
    let host = arguments[6].clone();
    let gui = MainThread {
        instance: format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ),
    };
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy:1_isize];
        let tick = block2::RcBlock::new(|_: *mut AnyObject| crate::indicator::refresh());
        let _: *mut AnyObject = msg_send![class!(NSTimer), scheduledTimerWithTimeInterval:0.1_f64, repeats:true, block:&*tick];
        std::thread::spawn(move || {
            let result = serve(&gui, &host, &mut stream);
            if let Err(error) = result {
                eprintln!("computer_use_connection_closed: {error}");
            }
            // The owning Host's connection is the component's lifetime. No orphan daemon.
            let _ = gui.run_on_main_thread(|| {
                let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![app, terminate:std::ptr::null::<AnyObject>()];
            });
        });
        let _: () = msg_send![app, run];
    }
    Ok(())
}

fn serve(gui: &MainThread, host: &str, stream: &mut TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Ok(());
        }
        let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let binding = &request["binding"];
        let result = if binding["hostInstanceId"] != host
            || binding["windowLabel"] != "main"
            || !binding["runId"].is_string()
            || !binding["sessionId"].is_string()
        {
            Err("computer_host_binding_mismatch".into())
        } else {
            crate::driver::execute(gui, binding, &request["input"])
        };
        let response = match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(message) => {
                let native = match crate::driver::status() {
                    Ok(status) => status,
                    Err(error) => json!({"statusError":error}),
                };
                json!({"ok":false,"message":message,"diagnostics":{
                    "phase":request["input"]["action"],"native":native}})
            }
        };
        writeln!(stream, "{response}").map_err(|e| e.to_string())?;
    }
}
