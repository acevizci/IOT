import ldap from "ldapjs";
import { decryptSecret } from "./crypto.js";

export interface LdapConfig {
  host: string;
  port: number;
  bind_dn: string;
  bind_password_encrypted: string;
  base_dn: string;
  user_search_filter: string;
  use_tls: boolean;
}

function bindAsync(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

function searchForDn(client: ldap.Client, baseDn: string, filter: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    client.search(baseDn, { filter, scope: "sub", attributes: ["dn"] }, (err, res) => {
      if (err) return reject(err);
      let foundDn: string | null = null;
      res.on("searchEntry", (entry) => {
        foundDn = entry.dn?.toString() || (entry as any).objectName?.toString() || null;
      });
      res.on("error", (searchErr) => reject(searchErr));
      res.on("end", () => resolve(foundDn));
    });
  });
}

// LDAP filter injection'a karşı: kullanıcı girdisindeki (email) özel LDAP filtre
// karakterlerini RFC 4515'e göre escape eder. identifier email formatında olduğu
// için pratik risk düşük, ama savunma derinliği için yine de uygulanıyor.
function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

// FAZ 4: gerçek LDAP bind ile kimlik doğrulama. Akış: (1) servis hesabıyla
// (bind_dn/bind_password) bağlan, (2) user_search_filter ile kullanıcının DN'ini
// bul, (3) TAMAMEN AYRI bir bağlantıyla, kullanıcının KENDİ girdiği şifreyle o
// DN'e bind dene -- gerçek kimlik doğrulaması bu ikinci bind'dir, kullanıcının
// şifresi bizim veritabanımızda HİÇ saklanmaz/işlenmez, sadece LDAP sunucusuna
// iletilir.
export async function authenticateViaLdap(config: LdapConfig, identifier: string, password: string): Promise<boolean> {
  // Boş şifre kontrolü: bazı LDAP sunucuları boş şifreyle "anonymous bind"i
  // başarılı sayar -- bu, şifre kontrolünün atlanması anlamına gelir.
  if (!password) return false;

  const url = `${config.use_tls ? "ldaps" : "ldap"}://${config.host}:${config.port}`;
  const serviceClient = ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });

  try {
    const bindPassword = decryptSecret(config.bind_password_encrypted);
    await bindAsync(serviceClient, config.bind_dn, bindPassword);

    const filter = config.user_search_filter.replace("%s", escapeLdapFilter(identifier));
    const userDn = await searchForDn(serviceClient, config.base_dn, filter);
    if (!userDn) return false;

    const userClient = ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });
    try {
      await bindAsync(userClient, userDn, password);
      return true;
    } catch {
      return false;
    } finally {
      userClient.unbind();
    }
  } catch (err) {
    console.error("[LDAP] Kimlik doğrulama hatası:", err);
    return false;
  } finally {
    serviceClient.unbind();
  }
}
