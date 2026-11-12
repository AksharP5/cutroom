import os,json,time,sys
pid=int(sys.argv[1]);duration=int(sys.argv[2]) if len(sys.argv)>2 else 30
p=f'/proc/{pid}'
def ticks():
 s=open(p+'/stat').read().rsplit(')',1)[1].split(); return int(s[11])+int(s[12])
def counts():
 fds=os.listdir(p+'/fd');watches=0;handles=0
 for fd in fds:
  try:
   info=open(p+'/fdinfo/'+fd).read(); watches+=info.count('inotify wd:'); handles+=('inotify wd:' in info)
  except OSError: pass
 return dict(fds=len(fds),inotifyHandles=handles,inotifyWatches=watches)
a=ticks();start=time.monotonic();before=counts();time.sleep(duration);elapsed=time.monotonic()-start
print(json.dumps(dict(pid=pid,seconds=elapsed,cpuPercent=100*(ticks()-a)/os.sysconf('SC_CLK_TCK')/elapsed,**before)))
