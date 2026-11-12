use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc,
    },
    time::Instant,
};

const QUEUE_SLOTS: usize = 32;
const QUEUE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum WriteError {
    Busy,
    Timeout,
    Closed,
}

struct Frame {
    bytes: Vec<u8>,
    deadline: Instant,
    result: mpsc::Sender<Result<(), WriteError>>,
    queued_bytes: Arc<AtomicUsize>,
}

impl Drop for Frame {
    fn drop(&mut self) {
        self.queued_bytes
            .fetch_sub(self.bytes.len(), Ordering::AcqRel);
    }
}

impl Frame {
    fn finish(self, result: Result<(), WriteError>) {
        let reply = self.result.clone();
        drop(self);
        let _ = reply.send(result);
    }
}

// Only this worker owns the pipe. Callers never acquire a lock that a blocked OS
// write holds; the supervisor can terminate the child to release that write.
#[derive(Clone)]
pub struct PipeWriter {
    queue: SyncSender<Frame>,
    queued_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
}

impl PipeWriter {
    pub fn start(mut pipe: impl Write + Send + 'static) -> Self {
        let (queue, receiver) = mpsc::sync_channel::<Frame>(QUEUE_SLOTS);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let worker_closed = closed.clone();
        std::thread::spawn(move || {
            while let Ok(frame) = receiver.recv() {
                if worker_closed.load(Ordering::Acquire) {
                    frame.finish(Err(WriteError::Closed));
                    continue;
                }
                if Instant::now() >= frame.deadline {
                    frame.finish(Err(WriteError::Timeout));
                    continue;
                }
                let result = pipe.write_all(&frame.bytes).map_err(|_| WriteError::Closed);
                if result.is_err() {
                    worker_closed.store(true, Ordering::Release);
                }
                frame.finish(result);
            }
        });
        Self {
            queue,
            queued_bytes,
            closed,
        }
    }

    pub fn send(&self, bytes: Vec<u8>, deadline: Instant) -> Result<(), WriteError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(WriteError::Closed);
        }
        if Instant::now() >= deadline {
            return Err(WriteError::Timeout);
        }
        let size = bytes.len();
        self.queued_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                queued
                    .checked_add(size)
                    .filter(|total| *total <= QUEUE_BYTES)
            })
            .map_err(|_| WriteError::Busy)?;
        let (result, reply) = mpsc::channel();
        let frame = Frame {
            bytes,
            deadline,
            result,
            queued_bytes: self.queued_bytes.clone(),
        };
        match self.queue.try_send(frame) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(WriteError::Busy),
            Err(TrySendError::Disconnected(_)) => return Err(WriteError::Closed),
        }
        reply
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| {
                Err(match error {
                    mpsc::RecvTimeoutError::Timeout => WriteError::Timeout,
                    mpsc::RecvTimeoutError::Disconnected => WriteError::Closed,
                })
            })
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, sync::Mutex, time::Duration};

    #[test]
    fn expired_frames_are_not_written_and_capacity_is_released() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let writer = PipeWriter::start(Sink(bytes.clone()));
        assert_eq!(
            writer.send(vec![1], Instant::now() - Duration::from_millis(1)),
            Err(WriteError::Timeout)
        );
        writer
            .send(vec![2], Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert_eq!(*bytes.lock().unwrap(), vec![2]);
        assert_eq!(writer.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn total_queued_bytes_are_bounded_before_enqueuing() {
        let writer = PipeWriter::start(io::sink());
        assert_eq!(
            writer.send(
                vec![0; QUEUE_BYTES + 1],
                Instant::now() + Duration::from_secs(1)
            ),
            Err(WriteError::Busy)
        );
        assert_eq!(writer.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_frame_that_expires_in_the_queue_is_never_written_later() {
        struct Gate {
            bytes: Arc<Mutex<Vec<u8>>>,
            first: bool,
            entered: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
        }
        impl Write for Gate {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.first {
                    self.first = false;
                    self.entered.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                self.bytes.lock().unwrap().extend(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (entered, waiting) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let writer = PipeWriter::start(Gate {
            bytes: bytes.clone(),
            first: true,
            entered,
            release: blocked,
        });
        let first = writer.clone();
        let sending = std::thread::spawn(move || {
            first.send(vec![1], Instant::now() + Duration::from_secs(1))
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            writer.send(vec![2], Instant::now() + Duration::from_millis(20)),
            Err(WriteError::Timeout)
        );
        release.send(()).unwrap();
        sending.join().unwrap().unwrap();
        writer
            .send(vec![3], Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert_eq!(*bytes.lock().unwrap(), vec![1, 3]);
        writer.close();
        assert_eq!(
            writer.send(vec![4], Instant::now() + Duration::from_secs(1)),
            Err(WriteError::Closed)
        );
    }
}
